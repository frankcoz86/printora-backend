// backend/routes/files.js
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mime from 'mime-types';
import { uploadFileToDrive } from '../drive.js';
import 'dotenv/config';

const router = express.Router();

// Create a temp dir for multer
const uploadTmp = path.join(os.tmpdir(), 'printora_uploads');
if (!fs.existsSync(uploadTmp)) fs.mkdirSync(uploadTmp, { recursive: true });

const maxMb = Number(process.env.MAX_UPLOAD_MB || 2048);
const allowed = (process.env.ALLOWED_EXTENSIONS || 'pdf,tif,tiff,png,jpg,jpeg,ai,cdr')
  .split(',')
  .map((s) => s.trim().toLowerCase());

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadTmp),
  filename: (req, file, cb) => {
    // keep original name; Make/Day4 can rename when moving to order folder
    cb(null, file.originalname);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error(`File type .${ext} not allowed. Allowed: ${allowed.join(', ')}`));
    }
    cb(null, true);
  },
});

router.post('/upload', upload.single('file'), async (req, res) => {
  const stagingId = process.env.DRIVE_STAGING_FOLDER_ID;
  if (!stagingId) {
    // Safety check
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: 'DRIVE_STAGING_FOLDER_ID not set' });
  }

  if (!req.file) return res.status(400).json({ error: 'No file provided (field name: file)' });

  const localPath = req.file.path;
  const fileName = req.file.originalname;
  const mimeType = mime.lookup(fileName) || req.file.mimetype || 'application/octet-stream';

  try {
    const result = await uploadFileToDrive({
      localPath,
      fileName,
      mimeType,
      parentId: stagingId,
    });

    // Clean up temp file
    fs.unlink(localPath, () => {});

    return res.json({
      ok: true,
      driveFileId: result.id,
      webViewLink: result.webViewLink,
      name: result.name,
      mimeType: result.mimeType,
      size: result.size,
    });
  } catch (err) {
    // Clean up temp file on error
    fs.unlink(localPath, () => {});
    console.error('Drive upload error:', err);
    return res.status(500).json({ error: 'Upload failed', details: String(err?.message || err) });
  }
});

export default router;