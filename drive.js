// backend/drive.js
import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Auth using a Google Service Account key file.
 * TIP: For Shared Drives, make sure the service account is a member
 * with at least "Content manager" permission.
 */
function getAuth() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error('Service account JSON not found. Check GOOGLE_SERVICE_ACCOUNT_JSON_PATH.');
  }
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: SCOPES,
  });
}

export function getDrive() {
  const auth = getAuth();
  return google.drive({ version: 'v3', auth });
}

/**
 * Upload a local file to Google Drive under a parent folder (Shared Drive supported).
 * @param {object} params
 * @param {string} params.localPath - Full local path to the file on disk
 * @param {string} params.fileName  - File name to use in Drive
 * @param {string} params.mimeType  - MIME type
 * @param {string} params.parentId  - Target parent folder ID (e.g., your _staging folder in Shared Drive)
 * @returns {Promise<{id:string, webViewLink:string, name:string, mimeType:string, size:number}>}
 */
export async function uploadFileToDrive({ localPath, fileName, mimeType, parentId }) {
  const drive = getDrive();

  const { data } = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType,
      body: fs.createReadStream(localPath),
    },
    fields: 'id, name, mimeType, size, webViewLink',
    supportsAllDrives: true, // IMPORTANT for Shared Drives
  });

  // Fetch complete metadata (ensures webViewLink is present)
  const { data: full } = await drive.files.get({
    fileId: data.id,
    fields: 'id, name, mimeType, size, webViewLink, parents',
    supportsAllDrives: true,
  });

  return {
    id: full.id,
    name: full.name,
    mimeType: full.mimeType,
    size: Number(full.size || 0),
    webViewLink: full.webViewLink,
  };
}

/**
 * Create a folder under a parent (Shared Drive supported).
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.parentId
 * @returns {Promise<{id:string, name:string, webViewLink?:string}>}
 */
export async function createFolder({ name, parentId }) {
  const drive = getDrive();

  const { data } = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  return data;
}

/**
 * Find a folder by name under a parent. Returns the first match or null.
 * NOTE: Folder names are not guaranteed to be unique—prefer IDs where possible.
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.parentId
 * @returns {Promise<{id:string, name:string} | null>}
 */
export async function findFolder({ name, parentId }) {
  const drive = getDrive();

  const qParts = [
    `mimeType = 'application/vnd.google-apps.folder'`,
    `name = '${name.replace(/'/g, "\\'")}'`,
  ];
  if (parentId) qParts.push(`'${parentId}' in parents`);

  const { data } = await drive.files.list({
    q: qParts.join(' and '),
    fields: 'files(id, name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    spaces: 'drive',
    pageSize: 10,
    corpora: 'drive', // using a single drive (the shared drive) when querying by parent
  });

  const files = data.files || [];
  return files.length ? files[0] : null;
}

/**
 * Ensure a nested folder path exists under a root, creating any missing segments.
 * @param {object} params
 * @param {string} params.rootId - Starting folder ID (e.g., GOOGLE_DRIVE_ROOT_FOLDER_ID)
 * @param {string[]} params.segments - e.g., ['2025','09','ORD-1234-JOHN-ROME','editor-files']
 * @returns {Promise<string>} - The ID of the final folder
 */
export async function ensureFolderPath({ rootId, segments }) {
  if (!rootId) throw new Error('rootId is required for ensureFolderPath');
  let currentParent = rootId;

  for (const seg of segments) {
    const existing = await findFolder({ name: seg, parentId: currentParent });
    if (existing) {
      currentParent = existing.id;
      continue;
    }
    const created = await createFolder({ name: seg, parentId: currentParent });
    currentParent = created.id;
  }
  return currentParent;
}

/**
 * Move a file to a new parent folder (Shared Drive supported).
 * @param {object} params
 * @param {string} params.fileId
 * @param {string} params.newParentId
 * @param {boolean} [params.keepOldParents=false] - if false, removes previous parents (recommended)
 * @returns {Promise<{id:string, parents:string[]}>}
 */
export async function moveFileToFolder({ fileId, newParentId, keepOldParents = false }) {
  const drive = getDrive();

  // Get current parents
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, parents',
    supportsAllDrives: true,
  });

  const previousParents = (meta.parents || []).join(',');
  const request = {
    fileId,
    addParents: newParentId,
    fields: 'id, parents',
    supportsAllDrives: true,
  };

  if (!keepOldParents && previousParents) {
    request.removeParents = previousParents;
  }

  const { data } = await drive.files.update(request);
  return data;
}

/**
 * Fetch basic file metadata (including webViewLink).
 * @param {string} fileId
 * @returns {Promise<{id:string,name:string,mimeType:string,size?:string,webViewLink?:string,parents?:string[]}>}
 */
export async function getFile(fileId) {
  const drive = getDrive();
  const { data } = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, webViewLink, parents',
    supportsAllDrives: true,
  });
  return data;
}