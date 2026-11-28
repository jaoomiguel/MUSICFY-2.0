const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;

const requiredTidbSettings = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE', 'JWT_SECRET'];
const missingTidbSettings = requiredTidbSettings.filter((setting) => !process.env[setting]);
if (missingTidbSettings.length) {
  throw new Error(`Missing configuration: ${missingTidbSettings.join(', ')}. Configure these values in .env.`);
}
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long.');
}

const uploadsRoot = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'uploads');
const artistBannerUploadDir = path.join(uploadsRoot, 'artist-banners');
const imageUploadDir = path.join(uploadsRoot, 'images');
fs.mkdirSync(artistBannerUploadDir, { recursive: true });
fs.mkdirSync(imageUploadDir, { recursive: true });
const artistBannerUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, callback) => callback(null, file.mimetype === 'image/gif'),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const supportedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, callback) => callback(null, supportedImageMimeTypes.has(file.mimetype)),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function getImageExtension(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const gifSignature = buffer.subarray(0, 6).toString('ascii');
  if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

const imageMimeTypes = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const isValidImageUrl = (value) => value == null || (typeof value === 'string' && value.length <= 512);
const normalizeAccentColor = (value) => (
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null
);

async function validateReviewGifUrl(value) {
  if (value == null || value === '') return { valid: true, url: null };
  if (typeof value !== 'string' || value.length > 512) return { valid: false, url: null };

  let parsedUrl;
  try {
    parsedUrl = new URL(value.trim(), 'http://musicfy.local');
  } catch {
    return { valid: false, url: null };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return { valid: false, url: null };
  const imageAssetMatch = parsedUrl.pathname.match(/\/api\/images\/([a-f\d]{32})$/i);
  if (imageAssetMatch) {
    const asset = await getDb('SELECT mime_type FROM image_assets WHERE id = ?', [imageAssetMatch[1]]);
    return { valid: asset?.mime_type === 'image/gif', url: value.trim() };
  }

  return { valid: /\.gif$/i.test(parsedUrl.pathname), url: value.trim() };
}

async function saveReviewGif(reviewId, gifUrl) {
  if (!gifUrl) {
    await runDb('DELETE FROM review_media WHERE review_id = ?', [reviewId]);
    return;
  }

  await runDb(
    `INSERT INTO review_media (review_id, gif_url) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE gif_url = VALUES(gif_url)`,
    [reviewId, gifUrl]
  );
}

const tidbPort = Number(process.env.TIDB_PORT || 4000);
if (!Number.isInteger(tidbPort) || tidbPort < 1 || tidbPort > 65535) {
  throw new Error('TIDB_PORT must be a valid TCP port.');
}

const tlsOptions = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
if (process.env.TIDB_CA_PATH) {
  tlsOptions.ca = fs.readFileSync(path.resolve(process.env.TIDB_CA_PATH), 'utf8');
}

const db = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: tidbPort,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: tlsOptions,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 10000,
  dateStrings: true,
});

const runDb = async (sql, params = []) => {
  const [result] = await db.execute(sql, params);
  return {
    id: Number(result.insertId || 0),
    changes: Number(result.affectedRows || 0),
  };
};

const execDb = async (sql) => {
  const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await db.query(statement);
  }
};

const getDb = async (sql, params = []) => {
  const [rows] = await db.execute(sql, params);
  return rows[0];
};

const allDb = async (sql, params = []) => {
  const [rows] = await db.execute(sql, params);
  return rows;
};

const attachReleaseArtists = async (releases) => {
  if (!Array.isArray(releases) || !releases.length) return releases || [];
  const releaseIds = [...new Set(releases.map((release) => Number(release.id)).filter(Number.isSafeInteger))];
  if (!releaseIds.length) return releases;

  const placeholders = releaseIds.map(() => '?').join(', ');
  const rows = await allDb(`
    SELECT ra.release_id, ra.sort_order, a.id, a.name, a.image_url
    FROM release_artists ra
    JOIN artists a ON a.id = ra.artist_id
    WHERE ra.release_id IN (${placeholders})
    ORDER BY ra.release_id ASC, ra.sort_order ASC, a.name ASC
  `, releaseIds);

  const artistsByRelease = new Map();
  for (const row of rows) {
    const artistList = artistsByRelease.get(row.release_id) || [];
    artistList.push({ id: row.id, name: row.name, image_url: row.image_url });
    artistsByRelease.set(row.release_id, artistList);
  }

  return releases.map((release) => ({
    ...release,
    featured_artists: artistsByRelease.get(release.id) || [],
  }));
};

const saveReleaseArtists = async (releaseId, primaryArtistId, requestedArtistIds = []) => {
  await runDb('DELETE FROM release_artists WHERE release_id = ?', [releaseId]);
  if (!Array.isArray(requestedArtistIds)) return;

  const uniqueIds = [...new Set(requestedArtistIds
    .map((artistId) => Number(artistId))
    .filter((artistId) => Number.isSafeInteger(artistId) && artistId > 0 && artistId !== Number(primaryArtistId)))];

  for (const [index, artistId] of uniqueIds.entries()) {
    const artist = await getDb('SELECT id FROM artists WHERE id = ?', [artistId]);
    if (!artist) throw Object.assign(new Error('One of the featured artists does not exist.'), { statusCode: 400 });
    await runDb(
      'INSERT INTO release_artists (release_id, artist_id, sort_order) VALUES (?, ?, ?)',
      [releaseId, artistId, index]
    );
  }
};

const createNotificationOnConnection = async (connection, userId, type, message, linkUrl, actorUserId = null, playlistCollaboratorId = null) => {
  const [result] = await connection.execute(
    'INSERT INTO notifications (user_id, type, actor_user_id, message, link_url, playlist_collaborator_id) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, type, actorUserId, message, linkUrl, playlistCollaboratorId]
  );
  return { id: Number(result.insertId || 0), changes: Number(result.affectedRows || 0) };
};

const createNotification = async (userId, type, message, linkUrl, actorUserId = null, playlistCollaboratorId = null) => {
  await runDb(
    'INSERT INTO notifications (user_id, type, actor_user_id, message, link_url, playlist_collaborator_id) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, type, actorUserId, message, linkUrl, playlistCollaboratorId]
  );
};

const notifyReleaseAudience = async (releaseId, artistId, releaseTitle, artistName) => {
  await runDb(`
    INSERT INTO notifications (user_id, type, message, link_url)
    SELECT audience.user_id, 'NEW_RELEASE', ?, ?
    FROM (
      SELECT user_id FROM pre_saves WHERE release_id = ?
      UNION
      SELECT user_id FROM artist_follows WHERE artist_id = ?
    ) AS audience
  `, [`Novo lançamento de ${artistName}: ${releaseTitle}.`, `/releases/${releaseId}`, releaseId, artistId]);
};

const publishDueReleases = async () => {
  const dueReleases = await allDb(`
    SELECT r.id, r.title, r.artist_id, a.name AS artist_name
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    WHERE r.status = 'PREVIEW' AND r.release_date <= CURDATE()
    ORDER BY r.release_date ASC, r.id ASC
  `);

  for (const release of dueReleases) {
    const updated = await runDb(
      `UPDATE releases SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PREVIEW' AND release_date <= CURDATE()`,
      [release.id]
    );
    if (updated.changes) {
      await notifyReleaseAudience(release.id, release.artist_id, release.title, release.artist_name);
    }
  }
};

const saveLegacyTrackContent = async (trackId, track) => {
  if (track.youtube_url) {
    await runDb(
      `INSERT IGNORE INTO track_links (track_id, platform, url, link_type) VALUES (?, 'YouTube', ?, 'streaming')`,
      [trackId, track.youtube_url]
    );
  }
  if (track.lyrics) {
    await runDb(
      `INSERT IGNORE INTO track_texts (track_id, content_type, language_code, content) VALUES (?, 'lyrics', 'und', ?)`,
      [trackId, track.lyrics]
    );
  }
  if (track.translation) {
    await runDb(
      `INSERT IGNORE INTO track_texts (track_id, content_type, language_code, content) VALUES (?, 'translation', 'und', ?)`,
      [trackId, track.translation]
    );
  }
};

const migrateLegacyTrackContent = async () => {
  await runDb(`
    INSERT IGNORE INTO track_links (track_id, platform, url, link_type)
    SELECT id, 'YouTube', youtube_url, 'streaming'
    FROM tracks
    WHERE TRIM(COALESCE(youtube_url, '')) <> ''
  `);
  await runDb(`
    INSERT IGNORE INTO track_texts (track_id, content_type, language_code, content)
    SELECT id, 'lyrics', 'und', lyrics
    FROM tracks
    WHERE TRIM(COALESCE(lyrics, '')) <> ''
  `);
  await runDb(`
    INSERT IGNORE INTO track_texts (track_id, content_type, language_code, content)
    SELECT id, 'translation', 'und', translation
    FROM tracks
    WHERE TRIM(COALESCE(translation, '')) <> ''
  `);
};

const normalizeUser = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    avatar_url: user.avatar_url,
    banner_url: user.banner_url,
    bio: user.bio,
    role: user.role || 'USER',
    is_suspended: Boolean(Number(user.is_suspended)),
    is_approved: Boolean(Number(user.is_approved)),
    created_at: user.created_at,
  };
};

const normalizePublicUser = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    avatar_url: user.avatar_url,
    banner_url: user.banner_url,
    bio: user.bio,
    created_at: user.created_at,
  };
};

const isFutureReleaseDate = (dateString) => {
  if (!dateString) return false;
  const releaseDate = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return releaseDate > today;
};

const sendToken = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.substring(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = parsePositiveId(decoded.id);
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token.' });

    const account = await getDb('SELECT id, `role`, is_suspended, is_approved FROM users WHERE id = ?', [userId]);
    if (!account) return res.status(401).json({ error: 'Account no longer exists.' });
    const isSuspended = Boolean(Number(account.is_suspended));
    const notificationAccessAllowed = (
      (req.method === 'GET' && req.path === '/api/notifications')
      || (req.method === 'POST' && req.path === '/api/notifications/read-all')
      || (req.method === 'POST' && /^\/api\/notifications\/\d+\/read$/.test(req.path))
    );
    const isApproved = Boolean(Number(account.is_approved));
    if (isSuspended && !notificationAccessAllowed) {
      return res.status(403).json({ error: 'Conta suspensa. Acesse apenas suas notificações.' });
    }

    req.user = {
      ...decoded,
      id: Number(account.id),
      role: account.role,
      is_suspended: isSuspended,
      is_approved: isApproved,
    };
    const isReadOnlyMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!isApproved && !isReadOnlyMethod && !notificationAccessAllowed) {
      return res.status(403).json({
        error: 'Sua conta ainda aguarda aprovação da equipe administrativa. Enquanto isso, você pode apenas ler o conteúdo.',
        code: 'ACCOUNT_PENDING_APPROVAL',
      });
    }
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }
    return next(error);
  }
};

const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.substring(7) : null;
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = parsePositiveId(decoded.id);
    if (userId) {
      const account = await getDb(
        'SELECT id, `role`, is_suspended, is_approved FROM users WHERE id = ?',
        [userId]
      );
      if (account) {
        req.user = {
          ...decoded,
          id: Number(account.id),
          role: account.role,
          is_suspended: Boolean(Number(account.is_suspended)),
          is_approved: Boolean(Number(account.is_approved)),
        };
      }
    }
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      req.user = null;
    } else {
      return next(error);
    }
  }
  return next();
};

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
};

let lastMusicBrainzRequestAt = 0;
let musicBrainzQueue = Promise.resolve();

const requestMusicBrainz = (url) => {
  const request = musicBrainzQueue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastMusicBrainzRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

    lastMusicBrainzRequestAt = Date.now();
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Musicfy/2.0.0 (https://github.com/joaolcs1212/MUSICFY-2.0-jl)',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`MusicBrainz responded with HTTP ${response.status}.`);
    return response.json();
  });

  musicBrainzQueue = request.then(() => undefined, () => undefined);
  return request;
};

const musicBrainzQuerySpecialCharacters = '+-!(){}[]^"~*?:\\/&|';
const escapeMusicBrainzQuery = (value) => Array.from(value, (character) => (
  musicBrainzQuerySpecialCharacters.includes(character) ? `\\${character}` : character
)).join('');

const musicBrainzGenreNames = (entity) => (
  [...(entity.genres || []), ...(entity.tags || [])]
    .map((tag) => typeof tag === 'string' ? tag : tag?.name)
    .filter(Boolean)
    .map((name) => name.trim())
    .filter((name, index, names) => names.findIndex((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase()) === index)
    .slice(0, 8)
);

const formatMusicBrainzDuration = (milliseconds) => {
  const seconds = Math.round(Number(milliseconds) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

async function initializeDatabase() {
  await execDb(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const accentColumns = [
    ['artists', 'accent_color'],
    ['releases', 'accent_color'],
  ];
  for (const [tableName, columnName] of accentColumns) {
    const column = await getDb(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    if (!column) {
      await execDb(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} VARCHAR(7) NULL`);
    }
  }

  const playlistSortOrderColumn = await getDb(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playlist_tracks' AND COLUMN_NAME = 'sort_order'
  `);
  if (!playlistSortOrderColumn) {
    await execDb('ALTER TABLE playlist_tracks ADD COLUMN sort_order INT UNSIGNED NOT NULL DEFAULT 0');
  }
  const playlistVisibilityColumn = await getDb(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playlists' AND COLUMN_NAME = 'is_public'
  `);
  if (!playlistVisibilityColumn) {
    await execDb('ALTER TABLE playlists ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 1 AFTER cover_url');
  }
  const messageShareColumns = [
    ['shared_release_id', 'BIGINT UNSIGNED NULL'],
    ['shared_track_id', 'BIGINT UNSIGNED NULL'],
  ];
  for (const [columnName, definition] of messageShareColumns) {
    const exists = await getDb(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'direct_messages' AND COLUMN_NAME = ?`, [columnName]);
    if (!exists) await execDb(`ALTER TABLE direct_messages ADD COLUMN ${columnName} ${definition} AFTER review_id`);
  }

  await execDb('DROP TABLE IF EXISTS email_verification_tokens');
  const emailVerifiedColumn = await getDb(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_verified'
  `);
  if (emailVerifiedColumn) {
    await execDb('ALTER TABLE users DROP COLUMN email_verified');
  }

  const featuredBannerColumn = await getDb(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'featured_releases' AND COLUMN_NAME = 'banner_url'
  `);
  if (!featuredBannerColumn) {
    await execDb('ALTER TABLE featured_releases ADD COLUMN banner_url VARCHAR(512) NULL');
  }

  const featuredDescriptionColumn = await getDb(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'featured_releases' AND COLUMN_NAME = 'description'
  `);
  if (!featuredDescriptionColumn) {
    await execDb('ALTER TABLE featured_releases ADD COLUMN description TEXT NULL');
  }

  const suspendedColumn = await getDb(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_suspended'
  `);
  if (!suspendedColumn) {
    await execDb('ALTER TABLE users ADD COLUMN is_suspended TINYINT(1) NOT NULL DEFAULT 0');
  }

  const approvalColumn = await getDb(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_approved'
  `);
  if (!approvalColumn) {
    await execDb('ALTER TABLE users ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 1');
  }

  await runDb(
    `INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('require_profile_approval', '1')`
  );

  const notificationColumns = [
    ['type', "VARCHAR(32) NOT NULL DEFAULT 'GENERAL'"],
    ['actor_user_id', 'BIGINT UNSIGNED NULL'],
    ['link_url', 'VARCHAR(512) NULL'],
    ['playlist_collaborator_id', 'BIGINT UNSIGNED NULL'],
  ];
  for (const [columnName, columnDefinition] of notificationColumns) {
    const column = await getDb(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = ?
    `, [columnName]);
    if (!column) {
      await execDb(`ALTER TABLE notifications ADD COLUMN \`${columnName}\` ${columnDefinition}`);
    }
  }

  const notificationIndex = await getDb(`
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND INDEX_NAME = 'idx_notifications_playlist_collaborator'
  `);
  if (!notificationIndex) {
    await execDb('ALTER TABLE notifications ADD INDEX idx_notifications_playlist_collaborator (playlist_collaborator_id)');
  }
  await execDb(`
    UPDATE notifications n
    LEFT JOIN playlist_collaborators pc ON pc.id = n.playlist_collaborator_id
    SET n.playlist_collaborator_id = NULL
    WHERE n.playlist_collaborator_id IS NOT NULL AND pc.id IS NULL
  `);
  const notificationForeignKey = await getDb(`
    SELECT CONSTRAINT_NAME
    FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND CONSTRAINT_NAME = 'fk_notifications_playlist_collaborator'
  `);
  if (!notificationForeignKey) {
    await execDb(`
      ALTER TABLE notifications
      ADD CONSTRAINT fk_notifications_playlist_collaborator
      FOREIGN KEY (playlist_collaborator_id) REFERENCES playlist_collaborators(id) ON DELETE SET NULL
    `);
  }

  const rolesRow = await getDb('SELECT COUNT(*) AS count FROM roles');
  if (Number(rolesRow?.count || 0) === 0) {
    await runDb("INSERT INTO roles (name, description) VALUES ('ADMIN', 'Administrator access');");
    await runDb("INSERT INTO roles (name, description) VALUES ('USER', 'Standard member access');");
  }

  const userCount = await getDb('SELECT COUNT(*) AS count FROM users');
  if (Number(userCount?.count || 0) === 0) {
    const adminUsername = process.env.MUSICFY_ADMIN_USERNAME || 'admin';
    const adminName = process.env.MUSICFY_ADMIN_NAME || 'Musicfy Admin';
    const adminEmail = process.env.MUSICFY_ADMIN_EMAIL || 'admin@musicfy.dev';
    const adminPassword = process.env.MUSICFY_ADMIN_PASSWORD;
    if (!adminPassword || adminPassword.length < 12) {
      throw new Error('Set MUSICFY_ADMIN_PASSWORD to at least 12 characters before initializing an empty database.');
    }

    const adminHash = bcrypt.hashSync(adminPassword, 10);
    await runDb(
      `INSERT INTO users (username, full_name, email, password_hash, avatar_url, banner_url, bio, \`role\`) VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMIN')`,
      [adminUsername, adminName, adminEmail, adminHash, 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=800&q=80', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=1200&q=80', 'Managing the platform and catalog.']
    );

    const userHash = bcrypt.hashSync('User123!', 10);
    await runDb(
      `INSERT INTO users (username, full_name, email, password_hash, avatar_url, banner_url, bio, \`role\`) VALUES (?, ?, ?, ?, ?, ?, ?, 'USER')`,
      ['dayana', 'Dayana Costa', 'dayana@example.com', userHash, 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=800&q=80', 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=1200&q=80', 'Taste-maker and playlist curator.']
    );
  }

  if (process.env.MUSICFY_ADMIN_RESET_PASSWORD === 'true') {
    const adminUsername = process.env.MUSICFY_ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.MUSICFY_ADMIN_PASSWORD;
    if (!adminPassword || adminPassword.length < 12) {
      throw new Error('MUSICFY_ADMIN_PASSWORD must be at least 12 characters to reset the admin password.');
    }

    const admin = await getDb(
      'SELECT id FROM users WHERE username = ? AND `role` = ?',
      [adminUsername, 'ADMIN']
    );
    if (!admin) {
      throw new Error(`Cannot reset password: ADMIN account "${adminUsername}" was not found.`);
    }

    await runDb(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [bcrypt.hashSync(adminPassword, 10), admin.id]
    );
    console.log(`Admin password reset for "${adminUsername}". Remove MUSICFY_ADMIN_RESET_PASSWORD from the service environment.`);
  }

  const genreCount = await getDb('SELECT COUNT(*) AS count FROM genres');
  if (Number(genreCount?.count || 0) === 0) {
    const genres = ['Pop', 'K-pop', 'R&B', 'Hip-Hop', 'Rap', 'Rock', 'Indie', 'Alternative', 'Electronic', 'Funk', 'MPB', 'Jazz', 'Classical', 'Country'];
    for (const genre of genres) {
      await runDb('INSERT INTO genres (name) VALUES (?)', [genre]);
    }
  }

  const artistCount = await getDb('SELECT COUNT(*) AS count FROM artists');
  if (Number(artistCount?.count || 0) === 0 && process.env.NODE_ENV !== 'production') {
    const firstArtist = await runDb(
      `INSERT INTO artists (name, bio, image_url, banner_url, genre) VALUES (?, ?, ?, ?, ?)`,
      ['Solar Tide', 'A luminous synth-pop project with cinematic hooks and club-ready textures.', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=800&q=80', 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=1200&q=80', 'Pop']
    );

    const secondArtist = await runDb(
      `INSERT INTO artists (name, bio, image_url, banner_url, genre) VALUES (?, ?, ?, ?, ?)`,
      ['Nova Bloom', 'R&B and alt-pop storytelling wrapped in lush production and warm vocal textures.', 'https://images.unsplash.com/photo-1521119989659-a83eee488004?auto=format&fit=crop&w=800&q=80', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80', 'R&B']
    );

    const thirdArtist = await runDb(
      `INSERT INTO artists (name, bio, image_url, banner_url, genre) VALUES (?, ?, ?, ?, ?)`,
      ['Glass Harbor', 'Electro-funk innovators creating immersive live energy and melodic basslines.', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=800&q=80', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=1200&q=80', 'Electronic']
    );

    const genreMap = await allDb('SELECT id, name FROM genres');
    const map = Object.fromEntries(genreMap.map((row) => [row.name, row.id]));

    await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [firstArtist.id, map['Pop'] || 1]);
    await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [firstArtist.id, map['Electronic'] || 9]);
    await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [secondArtist.id, map['R&B'] || 3]);
    await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [secondArtist.id, map['Indie'] || 7]);
    await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [thirdArtist.id, map['Funk'] || 10]);
    await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [thirdArtist.id, map['Electronic'] || 9]);

    const release1 = await runDb(
      `INSERT INTO releases (title, artist_id, cover_url, release_type, release_date, genre, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      ['Velvet Static', firstArtist.id, 'https://images.unsplash.com/photo-1525201548942-d8732f6617a0?auto=format&fit=crop&w=800&q=80', 'Album', '2025-10-18', 'Pop', 'A neon-lit album about the afterglow of midnight drives and fresh starts.']
    );
    const release2 = await runDb(
      `INSERT INTO releases (title, artist_id, cover_url, release_type, release_date, genre, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      ['Horizon Bloom', secondArtist.id, 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=800&q=80', 'EP', '2025-08-04', 'R&B', 'A warm, emotional EP built on longing, reinvention and soft beats.']
    );
    const release3 = await runDb(
      `INSERT INTO releases (title, artist_id, cover_url, release_type, release_date, genre, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PREVIEW')`,
      ['Mirage Run', thirdArtist.id, 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=800&q=80', 'Single', '2026-01-12', 'Electronic', 'A future-facing single designed for a sunrise drive across the city lights.']
    );

    await runDb(`INSERT INTO tracks (release_id, title, duration, explicit, youtube_url, lyrics, translation, track_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [release1.id, 'Velvet Static', '3:42', 0, 'https://www.youtube.com/watch?v=ScMzIvxBSi4', 'You were the color in my winter sky', 'You were the color in my winter sky', 1]);
    await runDb(`INSERT INTO tracks (release_id, title, duration, explicit, youtube_url, lyrics, translation, track_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [release1.id, 'Street Glow', '4:08', 0, 'https://www.youtube.com/watch?v=ScMzIvxBSi4', 'We kept the city warm with our voices', 'We kept the city warm with our voices', 2]);
    await runDb(`INSERT INTO tracks (release_id, title, duration, explicit, youtube_url, lyrics, translation, track_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [release2.id, 'Night Bloom', '3:15', 0, 'https://www.youtube.com/watch?v=ScMzIvxBSi4', 'The moon kept a secret in my pocket', 'The moon kept a secret in my pocket', 1]);
    await runDb(`INSERT INTO tracks (release_id, title, duration, explicit, youtube_url, lyrics, translation, track_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [release3.id, 'Mirage Run', '3:33', 0, 'https://www.youtube.com/watch?v=ScMzIvxBSi4', 'I chase the signal through the static glow', 'I chase the signal through the static glow', 1]);

    const sampleUser = await getDb("SELECT id FROM users WHERE username = 'dayana'");
    await runDb('INSERT INTO reviews (user_id, release_id, rating, review_text) VALUES (?, ?, ?, ?)', [sampleUser.id, release1.id, 9, 'A gorgeous emotional ride with peaks and textures that stick with you.']);
    await runDb('INSERT INTO reviews (user_id, release_id, rating, review_text) VALUES (?, ?, ?, ?)', [sampleUser.id, release2.id, 8, 'Lush vocals and precise production — definitely a release worth replaying.']);
    await runDb('INSERT INTO review_likes (review_id, user_id) VALUES (?, ?)', [1, 1]);

    await runDb('INSERT INTO playlists (user_id, name, description, cover_url) VALUES (?, ?, ?, ?)', [sampleUser.id, 'Late-Night Drive', 'Soft neon and warm synths for the city after dark.', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=800&q=80']);
    const playlist = await getDb('SELECT id FROM playlists WHERE user_id = ? ORDER BY id DESC LIMIT 1', [sampleUser.id]);
    const firstTrack = await getDb('SELECT id FROM tracks WHERE release_id = ? ORDER BY id LIMIT 1', [release1.id]);
    await runDb('INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (?, ?)', [playlist.id, firstTrack.id]);

    await runDb('INSERT INTO pre_saves (user_id, release_id) VALUES (?, ?)', [sampleUser.id, release3.id]);
    await runDb('INSERT INTO notifications (user_id, message) VALUES (?, ?)', [sampleUser.id, 'Mirage Run is now live.']);
    await runDb('INSERT INTO featured_releases (release_id, sort_order) VALUES (?, ?)', [release1.id, 1]);
    await runDb('INSERT INTO featured_releases (release_id, sort_order) VALUES (?, ?)', [release2.id, 2]);
  }

  await migrateLegacyTrackContent();
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads/artist-banners', express.static(artistBannerUploadDir));
app.use('/uploads/images', express.static(imageUploadDir));

app.get('/api/health', (req, res) => res.json({ ok: true, message: 'Musicfy API running.' }));

const linkEntityConfig = {
  artist: { table: 'artist_links', foreignKey: 'artist_id', sourceTable: 'artists' },
  release: { table: 'release_links', foreignKey: 'release_id', sourceTable: 'releases' },
  track: { table: 'track_links', foreignKey: 'track_id', sourceTable: 'tracks' },
};

app.get('/api/content/:entityType/:id/links', async (req, res) => {
  const config = Object.prototype.hasOwnProperty.call(linkEntityConfig, req.params.entityType)
    ? linkEntityConfig[req.params.entityType]
    : null;
  const entityId = Number(req.params.id);
  if (!config) return res.status(404).json({ error: 'Content type not found.' });
  if (!Number.isSafeInteger(entityId) || entityId < 1) return res.status(400).json({ error: 'Invalid content ID.' });

  const entity = await getDb(`SELECT id FROM ${config.sourceTable} WHERE id = ?`, [entityId]);
  if (!entity) return res.status(404).json({ error: 'Content not found.' });

  const links = await allDb(
    `SELECT id, platform, url, link_type, created_at FROM ${config.table} WHERE ${config.foreignKey} = ? ORDER BY id`,
    [entityId]
  );
  return res.json(links);
});

app.post('/api/content/:entityType/:id/links', requireAuth, requireAdmin, async (req, res) => {
  const config = Object.prototype.hasOwnProperty.call(linkEntityConfig, req.params.entityType)
    ? linkEntityConfig[req.params.entityType]
    : null;
  const entityId = Number(req.params.id);
  if (!config) return res.status(404).json({ error: 'Content type not found.' });
  if (!Number.isSafeInteger(entityId) || entityId < 1) return res.status(400).json({ error: 'Invalid content ID.' });

  const { platform, url, link_type } = req.body;
  if (typeof platform !== 'string' || !platform.trim() || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Platform and URL are required.' });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch (error) {
    return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS URL.' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Links must use HTTP or HTTPS.' });
  }

  const entity = await getDb(`SELECT id FROM ${config.sourceTable} WHERE id = ?`, [entityId]);
  if (!entity) return res.status(404).json({ error: 'Content not found.' });

  const defaultLinkType = req.params.entityType === 'artist' ? 'official' : 'streaming';
  await runDb(
    `INSERT IGNORE INTO ${config.table} (${config.foreignKey}, platform, url, link_type) VALUES (?, ?, ?, ?)`,
    [entityId, platform.trim(), parsedUrl.toString(), typeof link_type === 'string' && link_type.trim() ? link_type.trim() : defaultLinkType]
  );
  const link = await getDb(
    `SELECT id, platform, url, link_type, created_at FROM ${config.table} WHERE ${config.foreignKey} = ? AND platform = ? AND url = ?`,
    [entityId, platform.trim(), parsedUrl.toString()]
  );
  return res.status(201).json(link);
});

app.delete('/api/content/:entityType/:id/links/:linkId', requireAuth, requireAdmin, async (req, res) => {
  const config = Object.prototype.hasOwnProperty.call(linkEntityConfig, req.params.entityType)
    ? linkEntityConfig[req.params.entityType]
    : null;
  const entityId = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  if (!config) return res.status(404).json({ error: 'Content type not found.' });
  if (!Number.isSafeInteger(entityId) || entityId < 1 || !Number.isSafeInteger(linkId) || linkId < 1) {
    return res.status(400).json({ error: 'Invalid content or link ID.' });
  }

  const result = await runDb(
    `DELETE FROM ${config.table} WHERE id = ? AND ${config.foreignKey} = ?`,
    [linkId, entityId]
  );
  if (!result.changes) return res.status(404).json({ error: 'Link not found.' });
  return res.json({ deleted: true });
});

app.get('/api/tracks/:id/texts', async (req, res) => {
  const trackId = Number(req.params.id);
  if (!Number.isSafeInteger(trackId) || trackId < 1) return res.status(400).json({ error: 'Invalid track ID.' });
  const track = await getDb('SELECT id FROM tracks WHERE id = ?', [trackId]);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const texts = await allDb(
    `SELECT content_type, language_code, source_language_code, content, source_url, updated_at
    FROM track_texts WHERE track_id = ? ORDER BY content_type, language_code`,
    [trackId]
  );
  return res.json(texts);
});

app.put('/api/tracks/:id/texts', requireAuth, requireAdmin, async (req, res) => {
  const trackId = Number(req.params.id);
  if (!Number.isSafeInteger(trackId) || trackId < 1) return res.status(400).json({ error: 'Invalid track ID.' });
  const track = await getDb('SELECT id FROM tracks WHERE id = ?', [trackId]);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const { content_type, language_code, source_language_code, content, source_url } = req.body;
  const isLanguageCode = (value) => typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
  if (!['lyrics', 'translation'].includes(content_type) || !isLanguageCode(language_code) || typeof content !== 'string') {
    return res.status(400).json({ error: 'Provide a valid content type, language code, and text.' });
  }
  if (source_language_code != null && !isLanguageCode(source_language_code)) {
    return res.status(400).json({ error: 'Invalid source language code.' });
  }
  if (source_url != null && typeof source_url !== 'string') {
    return res.status(400).json({ error: 'Invalid source URL.' });
  }

  await runDb(`
    INSERT INTO track_texts (track_id, content_type, language_code, source_language_code, content, source_url)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_language_code = VALUES(source_language_code),
      content = VALUES(content),
      source_url = VALUES(source_url),
      updated_at = CURRENT_TIMESTAMP
  `, [trackId, content_type, language_code, source_language_code || null, content, source_url || null]);

  return res.json({ saved: true });
});

app.delete('/api/tracks/:id/texts/:contentType/:languageCode', requireAuth, requireAdmin, async (req, res) => {
  const trackId = Number(req.params.id);
  if (!Number.isSafeInteger(trackId) || trackId < 1) return res.status(400).json({ error: 'Invalid track ID.' });
  if (!['lyrics', 'translation'].includes(req.params.contentType)) {
    return res.status(400).json({ error: 'Invalid content type.' });
  }

  const result = await runDb(
    'DELETE FROM track_texts WHERE track_id = ? AND content_type = ? AND language_code = ?',
    [trackId, req.params.contentType, req.params.languageCode]
  );
  if (!result.changes) return res.status(404).json({ error: 'Track text not found.' });
  return res.json({ deleted: true });
});

app.post('/api/uploads/artist-banner', requireAuth, requireAdmin, (req, res, next) => {
  artistBannerUpload.single('banner')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'O GIF deve ter no máximo 10 MB.' });
      }
      return res.status(400).json({ error: 'Não foi possível enviar o GIF.' });
    }
    if (error) return next(error);
    return next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Selecione um arquivo GIF válido.' });
  }

  const signature = req.file.buffer.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    return res.status(415).json({ error: 'O arquivo enviado não é um GIF válido.' });
  }

  const filename = `${crypto.randomBytes(16).toString('hex')}.gif`;
  await fs.promises.writeFile(path.join(artistBannerUploadDir, filename), req.file.buffer, { flag: 'wx' });
  return res.status(201).json({ url: `/uploads/artist-banners/${filename}` });
});

app.post('/api/uploads/image', requireAuth, (req, res, next) => {
  imageUpload.single('image')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'A imagem deve ter no máximo 10 MB.' });
      }
      return res.status(400).json({ error: 'Não foi possível enviar a imagem.' });
    }
    if (error) return next(error);
    return next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Selecione uma imagem JPG, PNG, GIF ou WebP.' });
  }

  const extension = getImageExtension(req.file.buffer);
  if (!extension) {
    return res.status(415).json({ error: 'O conteúdo enviado não é uma imagem JPG, PNG, GIF ou WebP válida.' });
  }

  const filename = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
  const imageId = filename.slice(0, filename.lastIndexOf('.'));
  await runDb(
    'INSERT INTO image_assets (id, mime_type, image_data) VALUES (?, ?, ?)',
    [imageId, imageMimeTypes[extension], req.file.buffer]
  );
  return res.status(201).json({ url: `/api/images/${imageId}` });
});

app.get('/api/images/:id', async (req, res) => {
  if (!/^[a-f\d]{32}$/i.test(req.params.id)) {
    return res.status(404).json({ error: 'Image not found.' });
  }

  const image = await getDb(
    'SELECT mime_type, image_data FROM image_assets WHERE id = ?',
    [req.params.id]
  );
  if (!image) return res.status(404).json({ error: 'Image not found.' });

  res.set('Content-Type', image.mime_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.send(image.image_data);
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'Informe seu e-mail.' });
  const user = await getDb('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) return res.json({ message: 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.' });
  const token = crypto.randomBytes(32).toString('hex');
  await runDb('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);
  await runDb('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 MINUTE))', [user.id, token]);
  return res.json({ message: 'Solicitação criada. Configure um serviço de e-mail para enviar o link ao usuário.', reset_token: process.env.NODE_ENV === 'production' ? undefined : token });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!token || password.length < 6) return res.status(400).json({ error: 'Token e senha com pelo menos 6 caracteres são obrigatórios.' });
  const reset = await getDb('SELECT user_id FROM password_reset_tokens WHERE token = ? AND expires_at > CURRENT_TIMESTAMP', [token]);
  if (!reset) return res.status(400).json({ error: 'Este link expirou ou não é válido.' });
  await runDb('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [bcrypt.hashSync(password, 10), reset.user_id]);
  await runDb('DELETE FROM password_reset_tokens WHERE token = ?', [token]);
  return res.json({ message: 'Senha redefinida com sucesso.' });
});

app.get('/api/auth/google/callback', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) return res.redirect('/auth?google_error=not_configured');
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(req.query.code || ''), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' }) });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error('Google token exchange failed');
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email) throw new Error('Google profile unavailable');
    let user = await getDb('SELECT * FROM users WHERE email = ?', [profile.email.toLowerCase()]);
    if (!user) {
      const base = (profile.email.split('@')[0] || 'musicfy').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'musicfy';
      let username = base; let suffix = 1;
      while (await getDb('SELECT id FROM users WHERE username = ?', [username])) username = `${base}${suffix++}`;
      const result = await runDb(`INSERT INTO users (username, full_name, email, password_hash, avatar_url, bio, \`role\`, is_approved) VALUES (?, ?, ?, ?, ?, ?, 'USER', 1)`, [username, profile.name || username, profile.email.toLowerCase(), bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10), profile.picture || null, 'Conta criada com o Google.']);
      user = await getDb('SELECT * FROM users WHERE id = ?', [result.id]);
    }
    const token = sendToken(user);
    return res.redirect(`/auth?google_token=${encodeURIComponent(token)}`);
  } catch (error) { console.error('Google OAuth failed:', error); return res.redirect('/auth?google_error=failed'); }
});

app.get('/api/auth/google', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REDIRECT_URI) return res.status(503).json({ error: 'Login com Google ainda não foi configurado pelo administrador.' });
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_REDIRECT_URI, response_type: 'code', scope: 'openid email profile', access_type: 'offline', prompt: 'select_account' });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/registration-settings', async (req, res) => {
  const setting = await getDb(
    'SELECT setting_value FROM app_settings WHERE setting_key = ?',
    ['require_profile_approval']
  );
  if (!setting) {
    return res.status(503).json({ error: 'Registration settings are unavailable.' });
  }
  return res.json({ approval_required: setting.setting_value === '1' });
});

app.post('/api/auth/register', async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const {
      username: submittedUsername,
      full_name: submittedName,
      email: submittedEmail,
      password,
      confirmPassword,
    } = req.body;
    const username = typeof submittedUsername === 'string' ? submittedUsername.trim() : '';
    const full_name = typeof submittedName === 'string' ? submittedName.trim() : '';
    const email = typeof submittedEmail === 'string' ? submittedEmail.trim().toLowerCase() : '';
    if (!username || !full_name || !email || !password) {
      return res.status(400).json({ error: 'Nome, nome de usuário, e-mail e senha são obrigatórios.' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'As senhas não correspondem.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [settingRows] = await connection.execute(
      'SELECT setting_value FROM app_settings WHERE setting_key = ? FOR UPDATE',
      ['require_profile_approval']
    );
    if (!settingRows[0]) {
      throw new Error('Registration approval setting is missing.');
    }

    const approvalRequired = settingRows[0].setting_value === '1';
    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, email]
    );
    if (existingUsers.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({ error: 'Este nome de usuário ou e-mail já está cadastrado.' });
    }

    const [result] = await connection.execute(
      `INSERT INTO users (username, full_name, email, password_hash, avatar_url, bio, \`role\`, is_approved) VALUES (?, ?, ?, ?, ?, ?, 'USER', ?)`,
      [
        username,
        full_name,
        email,
        passwordHash,
        'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=800&q=80',
        'New to Musicfy.',
        approvalRequired ? 0 : 1,
      ]
    );
    const [userRows] = await connection.execute('SELECT * FROM users WHERE id = ?', [result.insertId]);
    await connection.commit();
    transactionStarted = false;
    const user = userRows[0];
    const token = sendToken(user);
    return res.status(201).json({ token, user: normalizeUser(user) });
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Failed to roll back account registration:', rollbackError);
      }
    }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Este nome de usuário ou e-mail já está cadastrado.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Registration failed.' });
  } finally {
    connection?.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await getDb('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = sendToken(user);
    return res.json({ token, user: normalizeUser(user) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await getDb('SELECT * FROM users WHERE id = ?', [req.user.id]);
  return res.json({ user: normalizeUser(user) });
});

app.get('/api/artists', async (req, res) => {
  const rows = await allDb(`
    SELECT a.*,
      (SELECT COUNT(*) FROM releases r WHERE r.artist_id = a.id) AS release_count,
      (
        SELECT GROUP_CONCAT(g.name SEPARATOR ', ')
        FROM artist_genres ag
        JOIN genres g ON g.id = ag.genre_id
        WHERE ag.artist_id = a.id
      ) AS genre_names
    FROM artists a
    ORDER BY a.name ASC
  `);

  return res.json(rows.map((artist) => ({ ...artist, genre_names: artist.genre_names || '' })));
});

app.get('/api/artists/:id', async (req, res) => {
  const artist = await getDb('SELECT * FROM artists WHERE id = ?', [req.params.id]);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });

  const genres = await allDb(`
    SELECT g.name FROM artist_genres ag
    JOIN genres g ON g.id = ag.genre_id
    WHERE ag.artist_id = ?
  `, [req.params.id]);

  const releases = await allDb(`
    SELECT r.*, a.name AS artist_name
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    WHERE r.artist_id = ?
      OR EXISTS (SELECT 1 FROM release_artists ra WHERE ra.release_id = r.id AND ra.artist_id = ?)
    ORDER BY r.release_date DESC
  `, [req.params.id, req.params.id]);

  return res.json({ artist, genres: genres.map((g) => g.name), releases: await attachReleaseArtists(releases) });
});

app.get('/api/artists/:id/follow', requireAuth, async (req, res) => {
  const artistId = parsePositiveId(req.params.id);
  if (!artistId) return res.status(400).json({ error: 'Invalid artist ID.' });

  const artist = await getDb('SELECT id FROM artists WHERE id = ?', [artistId]);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });

  const followState = await getDb(`
    SELECT
      EXISTS (SELECT 1 FROM artist_follows WHERE user_id = ? AND artist_id = ?) AS following,
      (SELECT COUNT(*) FROM artist_follows WHERE artist_id = ?) AS follower_count
  `, [req.user.id, artistId, artistId]);
  return res.json({
    following: Boolean(followState.following),
    follower_count: Number(followState.follower_count || 0),
  });
});

app.post('/api/artists/:id/follow', requireAuth, async (req, res) => {
  const artistId = parsePositiveId(req.params.id);
  if (!artistId) return res.status(400).json({ error: 'Invalid artist ID.' });

  const artist = await getDb('SELECT id FROM artists WHERE id = ?', [artistId]);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });

  await runDb('INSERT IGNORE INTO artist_follows (user_id, artist_id) VALUES (?, ?)', [req.user.id, artistId]);
  const count = await getDb('SELECT COUNT(*) AS follower_count FROM artist_follows WHERE artist_id = ?', [artistId]);
  return res.json({ following: true, follower_count: Number(count.follower_count || 0) });
});

app.delete('/api/artists/:id/follow', requireAuth, async (req, res) => {
  const artistId = parsePositiveId(req.params.id);
  if (!artistId) return res.status(400).json({ error: 'Invalid artist ID.' });

  const artist = await getDb('SELECT id FROM artists WHERE id = ?', [artistId]);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });

  await runDb('DELETE FROM artist_follows WHERE user_id = ? AND artist_id = ?', [req.user.id, artistId]);
  const count = await getDb('SELECT COUNT(*) AS follower_count FROM artist_follows WHERE artist_id = ?', [artistId]);
  return res.json({ following: false, follower_count: Number(count.follower_count || 0) });
});

app.get('/api/admin/musicbrainz/artists', requireAuth, requireAdmin, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query || query.length > 100) {
    return res.status(400).json({ error: 'Informe um nome de artista com até 100 caracteres.' });
  }

  const params = new URLSearchParams({
    query: `artist:"${escapeMusicBrainzQuery(query)}"`,
    fmt: 'json',
    limit: '10',
  });

  try {
    const data = await requestMusicBrainz(`https://musicbrainz.org/ws/2/artist/?${params}`);
    return res.json((data.artists || []).map((artist) => ({
      id: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation || '',
      country: artist.country || '',
      type: artist.type || '',
      genres: musicBrainzGenreNames(artist),
    })));
  } catch (error) {
    console.error('MusicBrainz artist search failed:', error.message);
    return res.status(502).json({ error: 'Não foi possível consultar o MusicBrainz agora. Tente novamente.' });
  }
});

app.get('/api/admin/musicbrainz/releases', requireAuth, requireAdmin, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const artist = typeof req.query.artist === 'string' ? req.query.artist.trim() : '';
  if (!query || query.length > 100 || !artist || artist.length > 100) {
    return res.status(400).json({ error: 'Informe o título e o artista, com até 100 caracteres cada.' });
  }

  const params = new URLSearchParams({
    query: `artist:"${escapeMusicBrainzQuery(artist)}" AND releasegroup:"${escapeMusicBrainzQuery(query)}"`,
    fmt: 'json',
    limit: '10',
  });

  try {
    const data = await requestMusicBrainz(`https://musicbrainz.org/ws/2/release-group/?${params}`);
    return res.json((data['release-groups'] || []).map((release) => ({
      id: release.id,
      title: release.title,
      artist: (release['artist-credit'] || [])
        .map((credit) => `${credit.name || credit.artist?.name || ''}${credit.joinphrase || ''}`)
        .join(''),
      date: release['first-release-date'] || '',
      type: release['primary-type'] || '',
      genres: musicBrainzGenreNames(release),
    })));
  } catch (error) {
    console.error('MusicBrainz release search failed:', error.message);
    return res.status(502).json({ error: 'Não foi possível consultar o MusicBrainz agora. Tente novamente.' });
  }
});

app.get('/api/admin/musicbrainz/releases/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Identificador de lançamento inválido.' });
  }

  const params = new URLSearchParams({
    'release-group': req.params.id,
    inc: 'recordings',
    fmt: 'json',
    limit: '100',
  });

  try {
    const data = await requestMusicBrainz(`https://musicbrainz.org/ws/2/release/?${params}`);
    const releases = data.releases || [];
    releases.sort((first, second) => {
      const firstDate = first.date || '9999';
      const secondDate = second.date || '9999';
      if (firstDate !== secondDate) return firstDate.localeCompare(secondDate);
      const firstTrackCount = (first.media || []).reduce((count, medium) => count + (medium.tracks || []).length, 0);
      const secondTrackCount = (second.media || []).reduce((count, medium) => count + (medium.tracks || []).length, 0);
      return secondTrackCount - firstTrackCount;
    });

    const selectedRelease = releases.find((release) => (
      (release.media || []).some((medium) => (medium.tracks || []).length)
    ));
    const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(selectedRelease?.date || '') ? selectedRelease.date : '';
    const tracks = (selectedRelease?.media || []).flatMap((medium) => (
      (medium.tracks || []).map((track) => ({
        title: track.title || track.recording?.title || '',
        duration: formatMusicBrainzDuration(track.length || track.recording?.length),
      }))
    ));

    return res.json({
      tracks,
      release_date: releaseDate,
      cover_url: `https://coverartarchive.org/release-group/${req.params.id}/front-500`,
    });
  } catch (error) {
    console.error('MusicBrainz release details lookup failed:', error.message);
    return res.status(502).json({ error: 'Não foi possível carregar as faixas no MusicBrainz agora. Tente novamente.' });
  }
});

app.post('/api/artists', requireAuth, requireAdmin, async (req, res) => {
  const { name, bio, image_url, banner_url, genres = [], accent_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Artist name is required.' });
  if (!isValidImageUrl(image_url) || !isValidImageUrl(banner_url)) {
    return res.status(400).json({ error: 'Use a valid image URL with at most 512 characters, or upload an image file.' });
  }

  const artist = await runDb(
    `INSERT INTO artists (name, bio, image_url, banner_url, genre, accent_color) VALUES (?, ?, ?, ?, ?, ?)`,
    [name, bio || '', image_url || '', banner_url || '', genres[0] || '', normalizeAccentColor(accent_color)]
  );

  for (const genreName of genres) {
    const found = await getDb('SELECT id FROM genres WHERE name = ?', [genreName]);
    if (found) {
      await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [artist.id, found.id]);
    }
  }

  return res.status(201).json({ message: 'Artist created.', artistId: artist.id });
});

app.put('/api/artists/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, bio, image_url, banner_url, genres = [], accent_color } = req.body;

  const existingArtist = await getDb('SELECT id FROM artists WHERE id = ?', [id]);
  if (!existingArtist) return res.status(404).json({ error: 'Artist not found.' });
  if (!name) return res.status(400).json({ error: 'Artist name is required.' });
  if (!isValidImageUrl(image_url) || !isValidImageUrl(banner_url)) {
    return res.status(400).json({ error: 'Use a valid image URL with at most 512 characters, or upload an image file.' });
  }

  await runDb(
    `UPDATE artists SET name = ?, bio = ?, image_url = ?, banner_url = ?, genre = ?, accent_color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [name, bio || '', image_url || '', banner_url || '', genres[0] || '', normalizeAccentColor(accent_color), id]
  );

  await runDb('DELETE FROM artist_genres WHERE artist_id = ?', [id]);
  for (const genreName of genres) {
    const found = await getDb('SELECT id FROM genres WHERE name = ?', [genreName]);
    if (found) {
      await runDb('INSERT IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)', [id, found.id]);
    }
  }

  return res.json({ message: 'Artist updated.' });
});

app.delete('/api/artists/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const releaseRows = await allDb('SELECT id FROM releases WHERE artist_id = ?', [id]);

  for (const release of releaseRows) {
    const trackRows = await allDb('SELECT id FROM tracks WHERE release_id = ?', [release.id]);
    const trackIds = trackRows.map((item) => item.id);

    if (trackIds.length) {
      await runDb('DELETE FROM playlist_tracks WHERE track_id IN (' + trackIds.map(() => '?').join(',') + ')', trackIds);
      await runDb('DELETE FROM favorites WHERE track_id IN (' + trackIds.map(() => '?').join(',') + ')', trackIds);
    }

    await runDb('DELETE FROM review_likes WHERE review_id IN (SELECT id FROM reviews WHERE release_id = ?)', [release.id]);
    await runDb('DELETE FROM pre_saves WHERE release_id = ?', [release.id]);
    await runDb('DELETE FROM featured_releases WHERE release_id = ?', [release.id]);
    await runDb('DELETE FROM reviews WHERE release_id = ?', [release.id]);
    await runDb('DELETE FROM tracks WHERE release_id = ?', [release.id]);
    await runDb('DELETE FROM releases WHERE id = ?', [release.id]);
  }

  await runDb('DELETE FROM artist_genres WHERE artist_id = ?', [id]);
  await runDb('DELETE FROM artists WHERE id = ?', [id]);

  return res.json({ message: 'Artist deleted.' });
});

app.get('/api/releases', async (req, res) => {
  const rows = await allDb(`
    SELECT r.*, a.name AS artist_name, a.image_url AS artist_image,
      rv.avg_rating, COALESCE(rv.review_count, 0) AS review_count
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    LEFT JOIN (
      SELECT rv.release_id, ROUND(AVG(rv.rating), 1) AS avg_rating, COUNT(*) AS review_count
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      WHERE u.is_suspended = 0
      GROUP BY release_id
    ) rv ON rv.release_id = r.id
    ORDER BY r.release_date DESC
  `);

  return res.json(await attachReleaseArtists(rows));
});

app.get('/api/releases/:id', async (req, res) => {
  const release = await getDb(`
    SELECT r.*, a.name AS artist_name,
      rv.avg_rating, COALESCE(rv.review_count, 0) AS review_count
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    LEFT JOIN (
      SELECT rv.release_id, ROUND(AVG(rv.rating), 1) AS avg_rating, COUNT(*) AS review_count
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      WHERE u.is_suspended = 0
      GROUP BY release_id
    ) rv ON rv.release_id = r.id
    WHERE r.id = ?
  `, [req.params.id]);

  if (!release) return res.status(404).json({ error: 'Release not found.' });
  const [releaseWithArtists] = await attachReleaseArtists([release]);
  const resultRelease = releaseWithArtists;

  let currentUserId = null;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      currentUserId = decoded.id;
    } catch (error) {
      currentUserId = null;
    }
  }

  const tracks = await allDb('SELECT * FROM tracks WHERE release_id = ? ORDER BY track_number ASC', [req.params.id]);
  const trackIds = tracks.map((track) => track.id);
  let trackTexts = [];
  let trackLinks = [];
  if (trackIds.length) {
    const placeholders = trackIds.map(() => '?').join(', ');
    trackTexts = await allDb(
      `SELECT track_id, content_type, language_code, source_language_code, content, source_url
      FROM track_texts WHERE track_id IN (${placeholders}) ORDER BY content_type, language_code`,
      trackIds
    );
    trackLinks = await allDb(
      `SELECT id, track_id, platform, url, link_type FROM track_links
      WHERE track_id IN (${placeholders}) ORDER BY id`,
      trackIds
    );
  }
  const enrichedTracks = tracks.map((track) => ({
    ...track,
    texts: trackTexts.filter((text) => text.track_id === track.id),
    links: trackLinks.filter((link) => link.track_id === track.id),
  }));
  const reviews = await allDb(`
    SELECT rv.*, rm.gif_url, u.username, u.avatar_url,
      r.accent_color AS release_accent_color, a.accent_color AS artist_accent_color,
      (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = rv.id) AS like_count,
      EXISTS (
        SELECT 1 FROM review_likes rl WHERE rl.review_id = rv.id AND rl.user_id = ?
      ) AS liked_by_user
    FROM reviews rv
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    JOIN users u ON u.id = rv.user_id
    JOIN releases r ON r.id = rv.release_id
    JOIN artists a ON a.id = r.artist_id
    WHERE rv.release_id = ?
      AND u.is_suspended = 0
    ORDER BY rv.created_at DESC
  `, [currentUserId || 0, req.params.id]);

  return res.json({ release: resultRelease, tracks: enrichedTracks, reviews });
});

app.post('/api/releases', requireAuth, requireAdmin, async (req, res) => {
  const {
    title,
    artist_id,
    artist_name,
    cover_url,
    release_type,
    release_date,
    genre,
    description,
    accent_color,
    tracks = [],
    featured_artist_ids = [],
  } = req.body;

  if (!title || !release_type || !release_date) {
    return res.status(400).json({ error: 'Título, tipo e data de lançamento são obrigatórios.' });
  }
  if (!isValidImageUrl(cover_url)) {
    return res.status(400).json({ error: 'Use uma URL de capa com até 512 caracteres ou carregue um arquivo de imagem.' });
  }

  let resolvedArtistId = null;
  if (artist_id !== undefined && artist_id !== null && artist_id !== '') {
    const requestedArtistId = Number(artist_id);
    if (!Number.isSafeInteger(requestedArtistId) || requestedArtistId < 1) {
      return res.status(400).json({ error: 'Selecione um artista válido cadastrado no catálogo.' });
    }

    const selectedArtist = await getDb('SELECT id FROM artists WHERE id = ?', [requestedArtistId]);
    if (!selectedArtist) {
      return res.status(400).json({ error: 'O artista selecionado não existe no catálogo. Atualize a página e selecione novamente.' });
    }
    resolvedArtistId = selectedArtist.id;
  } else if (artist_name) {
    const existingArtist = await getDb('SELECT id FROM artists WHERE name = ?', [artist_name]);
    if (existingArtist) {
      resolvedArtistId = existingArtist.id;
    } else {
      const createdArtist = await runDb(
        `INSERT INTO artists (name, bio, image_url, banner_url, genre) VALUES (?, ?, ?, ?, ?)`,
        [artist_name, 'Artista cadastrado via painel administrativo.', '', '', genre || '']
      );
      resolvedArtistId = createdArtist.id;
    }
  }

  if (!resolvedArtistId) {
    return res.status(400).json({ error: 'Selecione um artista ou informe o nome do artista.' });
  }
  if (!Array.isArray(featured_artist_ids)) {
    return res.status(400).json({ error: 'Os feats devem ser enviados como uma lista de artistas.' });
  }
  for (const featuredArtistId of featured_artist_ids) {
    const requestedId = Number(featuredArtistId);
    if (!Number.isSafeInteger(requestedId) || requestedId < 1) {
      return res.status(400).json({ error: 'Selecione apenas artistas válidos como feats.' });
    }
  }

  const isFuture = isFutureReleaseDate(release_date);
  const release = await runDb(
    `INSERT INTO releases (title, artist_id, cover_url, release_type, release_date, genre, description, status, accent_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, resolvedArtistId, cover_url || '', release_type, release_date, genre || '', description || '', isFuture ? 'PREVIEW' : 'ACTIVE', normalizeAccentColor(accent_color)]
  );
  await saveReleaseArtists(release.id, resolvedArtistId, featured_artist_ids);

  for (const [index, track] of tracks.entries()) {
    const createdTrack = await runDb(
      `INSERT INTO tracks (release_id, title, duration, explicit, youtube_url, lyrics, translation, track_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [release.id, track.title || `Faixa ${index + 1}`, track.duration || null, track.explicit ? 1 : 0, track.youtube_url || '', track.lyrics || '', track.translation || '', index + 1]
    );
    await saveLegacyTrackContent(createdTrack.id, track);
  }

  if (!isFuture) {
    const artist = await getDb('SELECT name FROM artists WHERE id = ?', [resolvedArtistId]);
    await notifyReleaseAudience(release.id, resolvedArtistId, title, artist.name);
  }

  return res.status(201).json({ message: 'Release created.', releaseId: release.id, status: isFuture ? 'PREVIEW' : 'ACTIVE' });
});

app.put('/api/releases/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, artist_id, artist_name, cover_url, release_type, release_date, genre, description, accent_color, tracks = [], featured_artist_ids = [] } = req.body;

  const existingRelease = await getDb('SELECT * FROM releases WHERE id = ?', [id]);
  if (!existingRelease) return res.status(404).json({ error: 'Release not found.' });
  if (!Array.isArray(tracks)) return res.status(400).json({ error: 'Tracks must be an array.' });
  if (!isValidImageUrl(cover_url)) {
    return res.status(400).json({ error: 'Use uma URL de capa com até 512 caracteres ou carregue um arquivo de imagem.' });
  }
  if (!Array.isArray(featured_artist_ids)) {
    return res.status(400).json({ error: 'Os feats devem ser enviados como uma lista de artistas.' });
  }

  const existingTracks = await allDb('SELECT id FROM tracks WHERE release_id = ? ORDER BY track_number ASC, id ASC', [id]);
  const existingTrackIds = new Set(existingTracks.map((track) => track.id));
  const retainedTrackIds = new Set();
  const trackAssignments = new Array(tracks.length).fill(null);
  for (const [index, track] of tracks.entries()) {
    if (track.id == null) continue;
    const trackId = Number(track.id);
    if (!Number.isSafeInteger(trackId) || !existingTrackIds.has(trackId) || retainedTrackIds.has(trackId)) {
      return res.status(400).json({ error: 'Track ID does not belong to this release or is duplicated.' });
    }
    trackAssignments[index] = trackId;
    retainedTrackIds.add(trackId);
  }
  for (const [index, trackId] of trackAssignments.entries()) {
    if (trackId != null) continue;
    const positionalTrackId = existingTracks[index]?.id;
    const fallbackTrackId = existingTracks.find((track) => !retainedTrackIds.has(track.id))?.id;
    const assignedTrackId = positionalTrackId != null && !retainedTrackIds.has(positionalTrackId)
      ? positionalTrackId
      : fallbackTrackId;
    if (assignedTrackId != null) {
      trackAssignments[index] = assignedTrackId;
      retainedTrackIds.add(assignedTrackId);
    }
  }

  let resolvedArtistId = existingRelease.artist_id;
  if (artist_id !== undefined && artist_id !== null && artist_id !== '') {
    const requestedArtistId = Number(artist_id);
    if (!Number.isSafeInteger(requestedArtistId) || requestedArtistId < 1) {
      return res.status(400).json({ error: 'Selecione um artista válido cadastrado no catálogo.' });
    }

    const selectedArtist = await getDb('SELECT id FROM artists WHERE id = ?', [requestedArtistId]);
    if (!selectedArtist) {
      return res.status(400).json({ error: 'O artista selecionado não existe no catálogo. Atualize a página e selecione novamente.' });
    }
    resolvedArtistId = selectedArtist.id;
  } else if (!resolvedArtistId && artist_name) {
    const existingArtist = await getDb('SELECT id FROM artists WHERE name = ?', [artist_name]);
    if (existingArtist) {
      resolvedArtistId = existingArtist.id;
    } else {
      const createdArtist = await runDb(
        `INSERT INTO artists (name, bio, image_url, banner_url, genre) VALUES (?, ?, ?, ?, ?)`,
        [artist_name, 'Artista cadastrado via painel administrativo.', '', '', genre || '']
      );
      resolvedArtistId = createdArtist.id;
    }
  }

  if (!resolvedArtistId) {
    return res.status(400).json({ error: 'Selecione um artista cadastrado no catálogo.' });
  }
  for (const featuredArtistId of featured_artist_ids) {
    const requestedId = Number(featuredArtistId);
    if (!Number.isSafeInteger(requestedId) || requestedId < 1) {
      return res.status(400).json({ error: 'Selecione apenas artistas válidos como feats.' });
    }
  }

  const isFuture = isFutureReleaseDate(release_date || existingRelease.release_date);
  await runDb(
    `UPDATE releases SET title = ?, artist_id = ?, cover_url = ?, release_type = ?, release_date = ?, genre = ?, description = ?, status = ?, accent_color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [title || existingRelease.title, resolvedArtistId, cover_url || existingRelease.cover_url, release_type || existingRelease.release_type, release_date || existingRelease.release_date, genre || existingRelease.genre, description || existingRelease.description, isFuture ? 'PREVIEW' : 'ACTIVE', normalizeAccentColor(accent_color), id]
  );
  await saveReleaseArtists(id, resolvedArtistId, featured_artist_ids);

  for (const [index, track] of tracks.entries()) {
    const values = [track.title || `Faixa ${index + 1}`, track.duration || null, track.explicit ? 1 : 0, track.youtube_url || '', track.lyrics || '', track.translation || '', index + 1];
    let trackId = trackAssignments[index];
    if (trackId != null) {
      await runDb(
        `UPDATE tracks SET title = ?, duration = ?, explicit = ?, youtube_url = ?, lyrics = ?, translation = ?, track_number = ? WHERE id = ? AND release_id = ?`,
        [...values, trackId, id]
      );
    } else {
      const createdTrack = await runDb(
        `INSERT INTO tracks (release_id, title, duration, explicit, youtube_url, lyrics, translation, track_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ...values]
      );
      trackId = createdTrack.id;
    }
    await runDb('DELETE FROM track_links WHERE track_id = ? AND platform = ?', [trackId, 'YouTube']);
    await runDb(
      `DELETE FROM track_texts WHERE track_id = ? AND language_code = 'und'`,
      [trackId]
    );
    await saveLegacyTrackContent(trackId, track);
  }

  const removedTrackIds = [...existingTrackIds].filter((trackId) => !retainedTrackIds.has(trackId));
  if (removedTrackIds.length) {
    const placeholders = removedTrackIds.map(() => '?').join(', ');
    await runDb(`DELETE FROM playlist_tracks WHERE track_id IN (${placeholders})`, removedTrackIds);
    await runDb(`DELETE FROM favorites WHERE track_id IN (${placeholders})`, removedTrackIds);
    await runDb(`DELETE FROM tracks WHERE id IN (${placeholders})`, removedTrackIds);
  }

  if (existingRelease.status !== 'ACTIVE' && !isFuture) {
    const artist = await getDb('SELECT name FROM artists WHERE id = ?', [resolvedArtistId]);
    await notifyReleaseAudience(id, resolvedArtistId, title || existingRelease.title, artist.name);
  }

  return res.json({ message: 'Release updated.' });
});

app.delete('/api/releases/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const release = await getDb('SELECT * FROM releases WHERE id = ?', [id]);
  if (!release) return res.status(404).json({ error: 'Release not found.' });

  const trackRows = await allDb('SELECT id FROM tracks WHERE release_id = ?', [id]);
  const trackIds = trackRows.map((item) => item.id);

  if (trackIds.length) {
    await runDb('DELETE FROM playlist_tracks WHERE track_id IN (' + trackIds.map(() => '?').join(',') + ')', trackIds);
    await runDb('DELETE FROM favorites WHERE track_id IN (' + trackIds.map(() => '?').join(',') + ')', trackIds);
  }

  await runDb('DELETE FROM review_likes WHERE review_id IN (SELECT id FROM reviews WHERE release_id = ?)', [id]);
  await runDb('DELETE FROM pre_saves WHERE release_id = ?', [id]);
  await runDb('DELETE FROM featured_releases WHERE release_id = ?', [id]);
  await runDb('DELETE FROM reviews WHERE release_id = ?', [id]);
  await runDb('DELETE FROM tracks WHERE release_id = ?', [id]);
  await runDb('DELETE FROM releases WHERE id = ?', [id]);

  return res.json({ message: 'Release deleted.' });
});

app.post('/api/reviews', requireAuth, async (req, res) => {
  const { release_id, rating, review_text, gif_url } = req.body;
  const releaseId = parsePositiveId(release_id);
  const parsedRating = Number(rating);
  if (!releaseId || !Number.isInteger(parsedRating) || parsedRating < 0 || parsedRating > 10) {
    return res.status(400).json({ error: 'Release and a rating from 0 to 10 are required.' });
  }
  if (review_text != null && typeof review_text !== 'string') {
    return res.status(400).json({ error: 'Review text must be a string.' });
  }
  const reviewText = review_text || '';
  if (reviewText.length > 300) {
    return res.status(400).json({ error: 'Reviews can contain at most 300 characters.' });
  }

  const hasGifUrl = Object.prototype.hasOwnProperty.call(req.body, 'gif_url');
  const reviewGif = hasGifUrl ? await validateReviewGifUrl(gif_url) : { valid: true, url: null };
  if (!reviewGif.valid) {
    return res.status(400).json({ error: 'Attach a valid GIF URL or upload a GIF file.' });
  }

  const existing = await getDb('SELECT id FROM reviews WHERE user_id = ? AND release_id = ?', [req.user.id, releaseId]);
  if (existing) {
    await runDb(`UPDATE reviews SET rating = ?, review_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [parsedRating, reviewText, existing.id]);
    if (hasGifUrl) await saveReviewGif(existing.id, reviewGif.url);
    return res.json({ message: 'Review updated.', reviewId: existing.id });
  }

  const review = await runDb(
    `INSERT INTO reviews (user_id, release_id, rating, review_text) VALUES (?, ?, ?, ?)`,
    [req.user.id, releaseId, parsedRating, reviewText]
  );
  if (hasGifUrl) await saveReviewGif(review.id, reviewGif.url);

  return res.status(201).json({ message: 'Review created.', reviewId: review.id });
});

app.get('/api/reviews/:id/share-preview', requireAuth, async (req, res) => {
  const reviewId = parsePositiveId(req.params.id);
  if (!reviewId) return res.status(400).json({ error: 'Review ID is invalid.' });

  const review = await getDb(`
    SELECT rv.id, rv.user_id, rv.release_id, rv.rating, rv.review_text, rv.created_at,
      rm.gif_url, u.username, u.full_name, u.avatar_url,
      r.title AS release_title, r.cover_url AS release_cover, a.name AS artist_name,
      r.accent_color AS release_accent_color, a.accent_color AS artist_accent_color
    FROM reviews rv
    JOIN users u ON u.id = rv.user_id
    JOIN releases r ON r.id = rv.release_id
    JOIN artists a ON a.id = r.artist_id
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    WHERE rv.id = ? AND u.is_suspended = 0 AND u.is_approved = 1
  `, [reviewId]);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  return res.json(review);
});

app.put('/api/reviews/:id', requireAuth, async (req, res) => {
  const reviewId = parsePositiveId(req.params.id);
  if (!reviewId) return res.status(400).json({ error: 'Review ID is invalid.' });

  const review = await getDb('SELECT * FROM reviews WHERE id = ?', [reviewId]);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (Number(review.user_id) !== Number(req.user.id) && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'You can only update your own review.' });
  }

  const { rating, review_text, gif_url } = req.body;
  const parsedRating = Number(rating);
  if (!Number.isInteger(parsedRating) || parsedRating < 0 || parsedRating > 10) {
    return res.status(400).json({ error: 'Rating must be a number from 0 to 10.' });
  }
  if (review_text != null && typeof review_text !== 'string') {
    return res.status(400).json({ error: 'Review text must be a string.' });
  }
  const reviewText = review_text || '';
  if (reviewText.length > 300) {
    return res.status(400).json({ error: 'Reviews can contain at most 300 characters.' });
  }

  const hasGifUrl = Object.prototype.hasOwnProperty.call(req.body, 'gif_url');
  const reviewGif = hasGifUrl ? await validateReviewGifUrl(gif_url) : { valid: true, url: null };
  if (!reviewGif.valid) {
    return res.status(400).json({ error: 'Attach a valid GIF URL or upload a GIF file.' });
  }

  await runDb(`UPDATE reviews SET rating = ?, review_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [parsedRating, reviewText, reviewId]);
  if (hasGifUrl) await saveReviewGif(reviewId, reviewGif.url);
  return res.json({ message: 'Review updated.' });
});

app.delete('/api/reviews/:id', requireAuth, async (req, res) => {
  const reviewId = parsePositiveId(req.params.id);
  if (!reviewId) return res.status(400).json({ error: 'Review ID is invalid.' });

  const review = await getDb(`
    SELECT rv.id, rv.user_id, rv.release_id, r.title AS release_title
    FROM reviews rv
    JOIN releases r ON r.id = rv.release_id
    WHERE rv.id = ?
  `, [reviewId]);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (Number(review.user_id) !== Number(req.user.id) && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'You can only delete your own review.' });
  }

  if (req.user.role === 'ADMIN' && Number(review.user_id) !== Number(req.user.id)) {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM review_likes WHERE review_id = ?', [reviewId]);
      await connection.execute('DELETE FROM reviews WHERE id = ?', [reviewId]);
      await connection.execute(
        'INSERT INTO notifications (user_id, type, actor_user_id, message, link_url) VALUES (?, ?, ?, ?, ?)',
        [
          review.user_id,
          'REVIEW_REMOVED',
          req.user.id,
          `Um administrador removeu sua resenha de ${review.release_title}.`,
          `/releases/${review.release_id}`,
        ]
      );
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Failed to roll back admin review removal:', rollbackError);
      }
      throw error;
    } finally {
      connection.release();
    }
    return res.json({ message: 'Review deleted and its author notified.' });
  }

  await runDb('DELETE FROM review_likes WHERE review_id = ?', [reviewId]);
  await runDb('DELETE FROM reviews WHERE id = ?', [reviewId]);
  return res.json({ message: 'Review deleted.' });
});

app.post('/api/reviews/:id/like', requireAuth, async (req, res) => {
  const review = await getDb(`
    SELECT rv.*, r.title AS release_title
    FROM reviews rv
    JOIN releases r ON r.id = rv.release_id
    WHERE rv.id = ?
  `, [req.params.id]);
  if (!review) return res.status(404).json({ error: 'Review not found.' });

  const existing = await getDb('SELECT id FROM review_likes WHERE review_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (existing) {
    await runDb('DELETE FROM review_likes WHERE id = ?', [existing.id]);
    return res.json({ liked: false });
  }

  const result = await runDb('INSERT INTO review_likes (review_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
  if (result.changes && Number(review.user_id) !== Number(req.user.id)) {
    const actor = await getDb('SELECT username, full_name FROM users WHERE id = ?', [req.user.id]);
    const actorName = actor.full_name || actor.username;
    await createNotification(
      review.user_id,
      'REVIEW_LIKE',
      `${actorName} curtiu sua resenha de ${review.release_title}.`,
      `/releases/${review.release_id}`,
      req.user.id
    );
  }
  return res.json({ liked: true });
});

app.get('/api/messages/unread-count', requireAuth, async (req, res) => {
  const result = await getDb(
    'SELECT COUNT(*) AS unread_count FROM direct_messages WHERE recipient_id = ? AND read_at IS NULL',
    [req.user.id]
  );
  return res.json({ unread_count: Number(result.unread_count || 0) });
});

app.get('/api/messages/conversations', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const conversations = await allDb(`
    SELECT u.id, u.username, u.full_name, u.avatar_url,
      m.body AS last_message_body, m.image_asset_id AS last_message_image_id,
      m.review_id AS last_message_review_id, m.sender_id AS last_message_sender_id,
      m.created_at AS last_message_created_at,
      (m.sender_id = ?) AS last_message_is_mine,
      (
        SELECT COUNT(*)
        FROM direct_messages unread
        WHERE unread.sender_id = u.id AND unread.recipient_id = ? AND unread.read_at IS NULL
      ) AS unread_count
    FROM (
      SELECT conversation.other_user_id, MAX(conversation.id) AS last_message_id
      FROM (
        SELECT id,
          CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_user_id
        FROM direct_messages
        WHERE sender_id = ? OR recipient_id = ?
      ) conversation
      GROUP BY conversation.other_user_id
    ) latest
    JOIN direct_messages m ON m.id = latest.last_message_id
    JOIN users u ON u.id = latest.other_user_id
    WHERE u.is_suspended = 0 AND u.is_approved = 1
    ORDER BY m.id DESC
    LIMIT 100
  `, [userId, userId, userId, userId, userId]);
  return res.json({ conversations });
});

app.get('/api/messages/:userId', requireAuth, async (req, res) => {
  const recipientId = parsePositiveId(req.params.userId);
  if (!recipientId || recipientId === req.user.id) {
    return res.status(400).json({ error: 'Conversation user is invalid.' });
  }

  const recipient = await getDb(
    'SELECT id, username, full_name, avatar_url FROM users WHERE id = ? AND is_suspended = 0 AND is_approved = 1',
    [recipientId]
  );
  if (!recipient) return res.status(404).json({ error: 'User not found.' });

  await runDb(
    'UPDATE direct_messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL',
    [recipientId, req.user.id]
  );

  const messages = await allDb(`
    SELECT m.id, m.sender_id, m.recipient_id, m.body, m.review_id, m.shared_release_id, m.shared_track_id, m.created_at,
      CASE WHEN m.image_asset_id IS NULL THEN NULL ELSE CONCAT('/api/images/', m.image_asset_id) END AS image_url,
      sender.username AS sender_username, sender.full_name AS sender_full_name, sender.avatar_url AS sender_avatar_url,
      rv.id AS shared_review_id, rv.rating AS shared_review_rating,
      rv.review_text AS shared_review_text, rv.release_id AS shared_review_release_id,
      rv_user.username AS shared_review_username, rv_user.full_name AS shared_review_full_name,
      r.title AS shared_review_release_title, r.cover_url AS shared_review_release_cover,
      a.name AS shared_review_artist_name, rm.gif_url AS shared_review_gif_url,
      r.accent_color AS shared_review_release_accent, a.accent_color AS shared_review_artist_accent,
      sr.title AS shared_release_title, sr.cover_url AS shared_release_cover, sra.name AS shared_release_artist_name,
      st.title AS shared_track_title, st.duration AS shared_track_duration, str.title AS shared_track_release_title
    FROM (
      SELECT id
      FROM direct_messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY id DESC
      LIMIT 100
    ) recent
    JOIN direct_messages m ON m.id = recent.id
    JOIN users sender ON sender.id = m.sender_id
    LEFT JOIN reviews rv ON rv.id = m.review_id
    LEFT JOIN users rv_user ON rv_user.id = rv.user_id AND rv_user.is_suspended = 0 AND rv_user.is_approved = 1
    LEFT JOIN releases r ON r.id = rv.release_id
    LEFT JOIN artists a ON a.id = r.artist_id
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    LEFT JOIN releases sr ON sr.id = m.shared_release_id
    LEFT JOIN artists sra ON sra.id = sr.artist_id
    LEFT JOIN tracks st ON st.id = m.shared_track_id
    LEFT JOIN releases str ON str.id = st.release_id
    ORDER BY m.id ASC
  `, [req.user.id, recipientId, recipientId, req.user.id]);
  return res.json({ user: recipient, messages });
});

app.post('/api/messages/:userId', requireAuth, async (req, res) => {
  const recipientId = parsePositiveId(req.params.userId);
  if (!recipientId || recipientId === req.user.id) {
    return res.status(400).json({ error: 'Conversation user is invalid.' });
  }

  const recipient = await getDb(
    'SELECT id FROM users WHERE id = ? AND is_suspended = 0 AND is_approved = 1',
    [recipientId]
  );
  if (!recipient) return res.status(404).json({ error: 'User not found.' });

  const rawBody = req.body?.body ?? '';
  if (typeof rawBody !== 'string') return res.status(400).json({ error: 'Message text must be a string.' });
  const body = rawBody.trim();
  if (body.length > 2000) return res.status(400).json({ error: 'Messages can contain at most 2000 characters.' });

  const imageUrl = req.body?.image_url;
  let imageAssetId = null;
  if (imageUrl != null && imageUrl !== '') {
    if (typeof imageUrl !== 'string') return res.status(400).json({ error: 'Message image is invalid.' });
    let imagePath;
    try {
      const parsedImageUrl = new URL(imageUrl, 'http://musicfy.local');
      if (!['http:', 'https:'].includes(parsedImageUrl.protocol)) {
        return res.status(400).json({ error: 'Message image is invalid.' });
      }
      imagePath = parsedImageUrl.pathname;
    } catch {
      return res.status(400).json({ error: 'Message image is invalid.' });
    }

    imageAssetId = imagePath.match(/^\/api\/images\/([a-f\d]{32})$/i)?.[1] || null;
    if (!imageAssetId) return res.status(400).json({ error: 'Upload an image before attaching it to a message.' });
    const imageAsset = await getDb('SELECT id FROM image_assets WHERE id = ?', [imageAssetId]);
    if (!imageAsset) return res.status(404).json({ error: 'Message image was not found.' });
  }

  const reviewId = req.body?.review_id == null || req.body.review_id === ''
    ? null
    : parsePositiveId(req.body.review_id);
  if (req.body?.review_id != null && req.body.review_id !== '' && !reviewId) {
    return res.status(400).json({ error: 'Review ID is invalid.' });
  }
  if (reviewId) {
    const review = await getDb(`
      SELECT rv.id
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      WHERE rv.id = ? AND u.is_suspended = 0 AND u.is_approved = 1
    `, [reviewId]);
    if (!review) return res.status(404).json({ error: 'Review not found.' });
  }

  const sharedReleaseId = req.body?.shared_release_id == null || req.body.shared_release_id === '' ? null : parsePositiveId(req.body.shared_release_id);
  const sharedTrackId = req.body?.shared_track_id == null || req.body.shared_track_id === '' ? null : parsePositiveId(req.body.shared_track_id);
  if ((req.body?.shared_release_id != null && req.body.shared_release_id !== '' && !sharedReleaseId) || (req.body?.shared_track_id != null && req.body.shared_track_id !== '' && !sharedTrackId)) {
    return res.status(400).json({ error: 'O álbum ou música compartilhado é inválido.' });
  }
  if (sharedReleaseId) {
    const release = await getDb('SELECT id FROM releases WHERE id = ?', [sharedReleaseId]);
    if (!release) return res.status(404).json({ error: 'Álbum não encontrado.' });
  }
  if (sharedTrackId) {
    const track = await getDb('SELECT id FROM tracks WHERE id = ?', [sharedTrackId]);
    if (!track) return res.status(404).json({ error: 'Música não encontrada.' });
  }

  if (!body && !imageAssetId && !reviewId && !sharedReleaseId && !sharedTrackId) {
    return res.status(400).json({ error: 'Write a message or attach an image or review.' });
  }

  const result = await runDb(
    'INSERT INTO direct_messages (sender_id, recipient_id, body, image_asset_id, review_id, shared_release_id, shared_track_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, recipientId, body || null, imageAssetId, reviewId, sharedReleaseId, sharedTrackId]
  );
  return res.status(201).json({ message_id: result.id });
});

app.get('/api/pre-saves/:releaseId', requireAuth, async (req, res) => {
  const existing = await getDb('SELECT id FROM pre_saves WHERE user_id = ? AND release_id = ?', [req.user.id, req.params.releaseId]);
  return res.json({ saved: Boolean(existing) });
});

app.post('/api/pre-saves/:releaseId', requireAuth, async (req, res) => {
  const release = await getDb('SELECT id FROM releases WHERE id = ?', [req.params.releaseId]);
  if (!release) return res.status(404).json({ error: 'Release not found.' });

  const existing = await getDb('SELECT id FROM pre_saves WHERE user_id = ? AND release_id = ?', [req.user.id, req.params.releaseId]);
  if (existing) {
    await runDb('DELETE FROM pre_saves WHERE id = ?', [existing.id]);
    return res.json({ saved: false });
  }

  await runDb('INSERT INTO pre_saves (user_id, release_id) VALUES (?, ?)', [req.user.id, req.params.releaseId]);
  return res.json({ saved: true });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  const [notifications, unreadCount] = await Promise.all([
    allDb(`
      SELECT n.id, n.type, n.actor_user_id, n.message, n.link_url, n.read_status, n.created_at,
        n.playlist_collaborator_id,
        u.username AS actor_username, u.full_name AS actor_full_name, u.avatar_url AS actor_avatar_url,
        pc.status AS playlist_invite_status, pc.playlist_id,
        p.name AS playlist_name
      FROM notifications n
      LEFT JOIN users u ON u.id = n.actor_user_id
      LEFT JOIN playlist_collaborators pc ON pc.id = n.playlist_collaborator_id
      LEFT JOIN playlists p ON p.id = pc.playlist_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 50
    `, [req.user.id]),
    getDb('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_status = 0', [req.user.id]),
  ]);
  return res.json({
    notifications,
    unread_count: Number(unreadCount.count || 0),
    account_suspended: Boolean(req.user.is_suspended),
  });
});

app.post('/api/notifications/:id/playlist-invite', requireAuth, async (req, res) => {
  const notificationId = parsePositiveId(req.params.id);
  const decision = req.body?.decision === 'accept' ? 'ACCEPTED' : req.body?.decision === 'decline' ? 'DECLINED' : null;
  if (!notificationId || !decision) return res.status(400).json({ error: 'Choose whether to accept or decline the invitation.' });

  const connection = await db.getConnection();
  let invitation;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT n.id, n.actor_user_id, n.playlist_collaborator_id, pc.playlist_id, pc.status,
        p.name AS playlist_name
      FROM notifications n
      JOIN playlist_collaborators pc ON pc.id = n.playlist_collaborator_id
      JOIN playlists p ON p.id = pc.playlist_id
      WHERE n.id = ? AND n.user_id = ?
      FOR UPDATE
    `, [notificationId, req.user.id]);
    invitation = rows[0];
    if (!invitation) {
      await connection.rollback();
      return res.status(404).json({ error: 'Invitation not found.' });
    }

    if (invitation.status === 'PENDING') {
      await connection.execute(
        'UPDATE playlist_collaborators SET status = ?, responded_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [decision, invitation.playlist_collaborator_id, req.user.id]
      );
      invitation.status = decision;
      const nextMessage = decision === 'ACCEPTED'
        ? `Você aceitou o convite para colaborar na playlist “${invitation.playlist_name}”.`
        : `Você recusou o convite para colaborar na playlist “${invitation.playlist_name}”.`;
      await connection.execute(
        'UPDATE notifications SET read_status = 1, message = ? WHERE id = ? AND user_id = ?',
        [nextMessage, notificationId, req.user.id]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return res.json({
    status: invitation.status,
    playlist_id: invitation.playlist_id,
    playlist_name: invitation.playlist_name,
    already_answered: invitation.status !== 'PENDING',
  });
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  const notificationId = parsePositiveId(req.params.id);
  if (!notificationId) return res.status(400).json({ error: 'Invalid notification ID.' });
  const result = await runDb(
    'UPDATE notifications SET read_status = 1 WHERE id = ? AND user_id = ?',
    [notificationId, req.user.id]
  );
  if (!result.changes) {
    const notification = await getDb('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [notificationId, req.user.id]);
    if (!notification) return res.status(404).json({ error: 'Notification not found.' });
  }
  return res.json({ message: 'Notification marked as read.' });
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  await runDb('UPDATE notifications SET read_status = 1 WHERE user_id = ? AND read_status = 0', [req.user.id]);
  return res.json({ message: 'All notifications marked as read.' });
});

app.get('/api/users', requireAuth, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length > 100) return res.status(400).json({ error: 'A busca deve ter no máximo 100 caracteres.' });
  if (query.length === 1) return res.status(400).json({ error: 'Digite pelo menos 2 caracteres para buscar pessoas.' });

  const pattern = `%${query}%`;
  const users = await allDb(`
    SELECT u.id, u.username, u.full_name, u.avatar_url, u.bio,
      (SELECT COUNT(*) FROM user_follows f WHERE f.followed_id = u.id) AS follower_count,
      EXISTS (
        SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = u.id
      ) AS is_following,
      EXISTS (
        SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = u.id
      ) AS followed_by_user,
      EXISTS (
        SELECT 1 FROM user_follows f WHERE f.follower_id = u.id AND f.followed_id = ?
      ) AS is_follower,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = u.id
        ) AND EXISTS (
          SELECT 1 FROM user_follows f WHERE f.follower_id = u.id AND f.followed_id = ?
        ) THEN 0
        WHEN EXISTS (
          SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = u.id
        ) OR EXISTS (
          SELECT 1 FROM user_follows f WHERE f.follower_id = u.id AND f.followed_id = ?
        ) THEN 1
        ELSE 2
      END AS relationship_priority
    FROM users u
    WHERE u.id <> ?
      AND u.is_suspended = 0
      AND u.is_approved = 1
      AND (? = '' OR u.username LIKE ? OR u.full_name LIKE ?)
    ORDER BY relationship_priority ASC, u.created_at DESC, u.id DESC
    LIMIT 30
  `, [
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    query,
    pattern,
    pattern,
  ]);

  return res.json(users);
});

app.get('/api/users/:userId', requireAuth, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId || userId === req.user.id) return res.status(400).json({ error: 'User ID is invalid.' });

  const user = await getDb(
    'SELECT id, username, full_name, avatar_url FROM users WHERE id = ? AND is_suspended = 0 AND is_approved = 1',
    [userId]
  );
  if (!user) return res.status(404).json({ error: 'User not found.' });
  return res.json(user);
});

app.post('/api/users/:userId/follow', requireAuth, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });
  if (userId === Number(req.user.id)) return res.status(400).json({ error: 'You cannot follow your own profile.' });

  const targetUser = await getDb('SELECT id FROM users WHERE id = ? AND is_suspended = 0 AND is_approved = 1', [userId]);
  if (!targetUser) return res.status(404).json({ error: 'User not found.' });

  const result = await runDb('INSERT IGNORE INTO user_follows (follower_id, followed_id) VALUES (?, ?)', [req.user.id, userId]);
  if (result.changes) {
    const actor = await getDb('SELECT username, full_name FROM users WHERE id = ?', [req.user.id]);
    const actorName = actor.full_name || actor.username;
    await createNotification(
      userId,
      'USER_FOLLOW',
      `${actorName} começou a seguir você.`,
      `/profile/${req.user.id}`,
      req.user.id
    );
  }
  return res.json({ following: true });
});

app.delete('/api/users/:userId/follow', requireAuth, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });
  if (userId === Number(req.user.id)) return res.status(400).json({ error: 'You cannot unfollow your own profile.' });

  const targetUser = await getDb('SELECT id FROM users WHERE id = ? AND is_suspended = 0 AND is_approved = 1', [userId]);
  if (!targetUser) return res.status(404).json({ error: 'User not found.' });
  await runDb('DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?', [req.user.id, userId]);
  return res.json({ following: false });
});

const getUserRelationshipList = async (req, res, relationship) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });
  const profileUser = await getDb(
    'SELECT id, is_approved FROM users WHERE id = ? AND is_suspended = 0',
    [userId]
  );
  const canViewPendingProfile = (
    Number(req.user?.id) === userId
    || req.user?.role === 'ADMIN'
  );
  if (!profileUser || (!Number(profileUser.is_approved) && !canViewPendingProfile)) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const followerColumn = relationship === 'followers' ? 'uf.followed_id' : 'uf.follower_id';
  const selectedColumn = relationship === 'followers' ? 'uf.follower_id' : 'uf.followed_id';
  const users = await allDb(`
    SELECT u.id, u.username, u.full_name, u.avatar_url, u.bio,
      (SELECT COUNT(*) FROM user_follows f WHERE f.followed_id = u.id) AS follower_count,
      EXISTS (
        SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = u.id
      ) AS followed_by_user
    FROM user_follows uf
    JOIN users u ON u.id = ${selectedColumn}
    WHERE ${followerColumn} = ?
      AND u.is_suspended = 0
      AND u.is_approved = 1
    ORDER BY uf.created_at DESC
    LIMIT 100
  `, [req.user?.id || 0, userId]);
  return res.json(users);
};

app.get('/api/users/:userId/followers', optionalAuth, (req, res) => getUserRelationshipList(req, res, 'followers'));
app.get('/api/users/:userId/following', optionalAuth, (req, res) => getUserRelationshipList(req, res, 'following'));

app.get('/api/profile/:userId', optionalAuth, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });
  const user = await getDb(
    'SELECT id, username, full_name, avatar_url, banner_url, bio, created_at, is_approved FROM users WHERE id = ? AND is_suspended = 0',
    [userId]
  );
  const canViewPendingProfile = (
    Number(req.user?.id) === userId
    || req.user?.role === 'ADMIN'
  );
  if (!user || (!Number(user.is_approved) && !canViewPendingProfile)) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const reviews = await allDb(`
    SELECT rv.*, rm.gif_url, r.title AS release_title, r.cover_url AS release_cover, a.name AS artist_name,
      r.accent_color AS release_accent_color, a.accent_color AS artist_accent_color,
      (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = rv.id) AS like_count,
      EXISTS (
        SELECT 1 FROM review_likes rl WHERE rl.review_id = rv.id AND rl.user_id = ?
      ) AS liked_by_user
    FROM reviews rv
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    JOIN releases r ON r.id = rv.release_id
    JOIN artists a ON a.id = r.artist_id
    WHERE rv.user_id = ?
    ORDER BY rv.created_at DESC
  `, [req.user?.id || 0, userId]);

  const playlists = await allDb(`
    SELECT p.*, (
      SELECT COUNT(*)
      FROM playlist_tracks pt
      WHERE pt.playlist_id = p.id
    ) AS track_count, (
      SELECT COUNT(*)
      FROM playlist_collaborators pc
      WHERE pc.playlist_id = p.id
        AND UPPER(pc.status) = 'ACCEPTED'
    ) AS collaborator_count
    FROM playlists p
    WHERE (
      p.user_id = ?
      OR EXISTS (
        SELECT 1
        FROM playlist_collaborators pc
        WHERE pc.playlist_id = p.id
          AND pc.user_id = ?
          AND UPPER(pc.status) = 'ACCEPTED'
      )
    ) AND (
      p.is_public = 1
      OR p.user_id = ?
      OR EXISTS (
        SELECT 1
        FROM playlist_collaborators pc
        WHERE pc.playlist_id = p.id
          AND pc.user_id = ?
          AND UPPER(pc.status) = 'ACCEPTED'
      )
    )
    ORDER BY p.created_at DESC, p.id DESC
  `, [userId, userId, req.user?.id || 0, req.user?.id || 0]);
  const favorites = await allDb(`
    SELECT f.*, t.title AS track_title, r.id AS release_id, r.title AS release_title,
      r.cover_url AS release_cover, a.name AS artist_name
    FROM favorites f
    JOIN tracks t ON t.id = f.track_id
    JOIN releases r ON r.id = t.release_id
    JOIN artists a ON a.id = r.artist_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `, [userId]);
  const social = await getDb(`
    SELECT
      (SELECT COUNT(*) FROM user_follows WHERE followed_id = ?) AS followers,
      (SELECT COUNT(*) FROM user_follows WHERE follower_id = ?) AS following,
      EXISTS (
        SELECT 1 FROM user_follows WHERE follower_id = ? AND followed_id = ?
      ) AS is_following
  `, [userId, userId, req.user?.id || 0, userId]);

  return res.json({ user: normalizePublicUser(user), reviews, playlists, favorites, social });
});

app.put('/api/users/me', requireAuth, async (req, res) => {
  const { username, full_name, bio, avatar_url, banner_url } = req.body;
  if (!isValidImageUrl(avatar_url) || !isValidImageUrl(banner_url)) {
    return res.status(400).json({ error: 'Use URLs de imagem com até 512 caracteres ou carregue arquivos de imagem.' });
  }

  await runDb(
    `UPDATE users SET username = ?, full_name = ?, bio = ?, avatar_url = ?, banner_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [username || '', full_name || '', bio || '', avatar_url || '', banner_url || '', req.user.id]
  );
  const user = await getDb('SELECT * FROM users WHERE id = ?', [req.user.id]);
  return res.json({ user: normalizeUser(user) });
});

app.get('/api/explore', optionalAuth, async (req, res) => {
  const featured = await allDb(`
    SELECT fr.sort_order, r.*, a.name as artist_name
    FROM featured_releases fr
    JOIN releases r ON r.id = fr.release_id
    JOIN artists a ON a.id = r.artist_id
    ORDER BY fr.sort_order ASC
  `);

  const recent = await allDb(`
    SELECT r.*, a.name AS artist_name
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    ORDER BY r.release_date DESC
    LIMIT 6
  `);

  const releases = await allDb(`
    SELECT r.*, a.name AS artist_name, a.image_url AS artist_image,
      rv.avg_rating, COALESCE(rv.review_count, 0) AS review_count
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    LEFT JOIN (
      SELECT rv.release_id, ROUND(AVG(rv.rating), 1) AS avg_rating, COUNT(*) AS review_count
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      WHERE u.is_suspended = 0
      GROUP BY rv.release_id
    ) rv ON rv.release_id = r.id
    ORDER BY r.release_date DESC, r.id DESC
  `);

  const artists = await allDb(`
    SELECT a.*,
      (SELECT COUNT(*) FROM releases r WHERE r.artist_id = a.id) AS release_count
    FROM artists a
    ORDER BY release_count DESC, a.name ASC
    LIMIT 5
  `);

  const reviews = await allDb(`
    SELECT rv.*, rm.gif_url, u.username, u.full_name, u.avatar_url,
      r.title AS release_title, r.cover_url AS cover_url, a.name AS artist_name,
      r.accent_color AS release_accent_color, a.accent_color AS artist_accent_color,
      (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = rv.id) AS like_count,
      EXISTS (
        SELECT 1 FROM review_likes rl WHERE rl.review_id = rv.id AND rl.user_id = ?
      ) AS liked_by_user
    FROM reviews rv
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    JOIN users u ON u.id = rv.user_id
    JOIN releases r ON r.id = rv.release_id
    JOIN artists a ON a.id = r.artist_id
    WHERE u.is_suspended = 0
    ORDER BY rv.created_at DESC
    LIMIT 6
  `, [req.user?.id || 0]);

  return res.json({
    featured: await attachReleaseArtists(featured),
    recent: await attachReleaseArtists(recent),
    releases: await attachReleaseArtists(releases),
    artists,
    reviews,
  });
});

app.get('/api/home-feed', optionalAuth, async (req, res) => {
  const featuredSlides = await allDb(`
    SELECT fr.id, fr.release_id,
      COALESCE(NULLIF(fr.banner_url, ''), r.cover_url, '') AS banner_url,
      COALESCE(fr.description, '') AS description, fr.sort_order,
      r.title, r.cover_url, r.release_type, a.name AS artist_name
    FROM featured_releases fr
    JOIN releases r ON r.id = fr.release_id
    JOIN artists a ON a.id = r.artist_id
    ORDER BY fr.sort_order ASC, fr.id ASC
  `);

  const recentReleases = await allDb(`
    SELECT r.*, a.name AS artist_name
    FROM releases r
    JOIN artists a ON a.id = r.artist_id
    WHERE r.status = 'ACTIVE'
      AND r.release_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 2 MONTH) AND CURDATE()
    ORDER BY r.release_date DESC, r.id DESC
    LIMIT 12
  `);

  const generalReviews = await allDb(`
    SELECT rv.*, rm.gif_url, u.username, u.full_name, u.avatar_url,
      r.title AS release_title, r.cover_url AS release_cover, a.name AS artist_name,
      r.accent_color AS release_accent_color, a.accent_color AS artist_accent_color,
      (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = rv.id) AS like_count,
      EXISTS (
        SELECT 1 FROM review_likes rl WHERE rl.review_id = rv.id AND rl.user_id = ?
      ) AS liked_by_user
    FROM reviews rv
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    JOIN users u ON u.id = rv.user_id
    JOIN releases r ON r.id = rv.release_id
    JOIN artists a ON a.id = r.artist_id
    WHERE u.is_suspended = 0
    ORDER BY rv.created_at DESC
  `, [req.user?.id || 0]);

  let followingReviews = [];
  if (req.user) {
    followingReviews = await allDb(`
      SELECT rv.*, rm.gif_url, u.username, u.full_name, u.avatar_url,
        r.title AS release_title, r.cover_url AS release_cover, a.name AS artist_name,
        r.accent_color AS release_accent_color, a.accent_color AS artist_accent_color,
        (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = rv.id) AS like_count,
        EXISTS (
          SELECT 1 FROM review_likes rl WHERE rl.review_id = rv.id AND rl.user_id = ?
        ) AS liked_by_user
      FROM reviews rv
      LEFT JOIN review_media rm ON rm.review_id = rv.id
      JOIN users u ON u.id = rv.user_id
      JOIN releases r ON r.id = rv.release_id
      JOIN artists a ON a.id = r.artist_id
      WHERE u.is_suspended = 0
        AND EXISTS (
          SELECT 1 FROM user_follows uf
          WHERE uf.follower_id = ? AND uf.followed_id = rv.user_id
        )
      ORDER BY rv.created_at DESC
    `, [req.user.id, req.user.id]);
  }

  return res.json({
    featured_slides: await attachReleaseArtists(featuredSlides),
    recent_releases: await attachReleaseArtists(recentReleases),
    following_reviews: followingReviews,
    general_reviews: generalReviews,
    reviews: generalReviews,
  });
});

app.get('/api/genres', async (req, res) => {
  const genres = await allDb('SELECT * FROM genres ORDER BY name ASC');
  return res.json(genres);
});

app.post('/api/genres', requireAuth, requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string'
    ? req.body.name.trim().replace(/\s+/g, ' ')
    : '';
  if (!name) return res.status(400).json({ error: 'Genre name is required.' });
  if (name.length > 191) return res.status(400).json({ error: 'Genre name must be 191 characters or fewer.' });

  await runDb('INSERT IGNORE INTO genres (name) VALUES (?)', [name]);
  const genre = await getDb('SELECT id, name FROM genres WHERE name = ?', [name]);
  if (!genre) return res.status(500).json({ error: 'Could not create genre.' });
  return res.status(201).json(genre);
});

const getPlaylistAccess = async (playlistId, userId = 0) => {
  const access = await getDb(`
    SELECT p.id, p.user_id,
      (p.user_id = ?) AS is_owner,
      EXISTS (
        SELECT 1 FROM playlist_collaborators pc
        WHERE pc.playlist_id = p.id AND pc.user_id = ? AND UPPER(pc.status) = 'ACCEPTED'
      ) AS is_collaborator
    FROM playlists p
    WHERE p.id = ?
  `, [userId, userId, playlistId]);
  if (!access) return null;
  return {
    ...access,
    is_owner: Boolean(Number(access.is_owner)),
    is_collaborator: Boolean(Number(access.is_collaborator)),
    can_edit_tracks: Boolean(Number(access.is_owner)) || Boolean(Number(access.is_collaborator)),
  };
};

const getPlaylistInviteIds = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw Object.assign(new Error('Choose up to 50 people to invite.'), { statusCode: 400 });
  }
  return [...new Set(value.map(parsePositiveId).filter(Boolean))];
};

app.get('/api/playlists', requireAuth, async (req, res) => {
  const playlists = await allDb(`
    SELECT p.*,
      (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
      (p.user_id = ?) AS is_owner,
      EXISTS (
        SELECT 1 FROM playlist_collaborators pc
        WHERE pc.playlist_id = p.id AND pc.user_id = ? AND UPPER(pc.status) = 'ACCEPTED'
      ) AS is_collaborator
    FROM playlists p
    WHERE p.user_id = ? OR EXISTS (
      SELECT 1 FROM playlist_collaborators pc
      WHERE pc.playlist_id = p.id AND pc.user_id = ? AND UPPER(pc.status) = 'ACCEPTED'
    )
    ORDER BY p.created_at DESC, p.id DESC
  `, [req.user.id, req.user.id, req.user.id, req.user.id]);
  return res.json(playlists);
});

app.get('/api/playlists/:playlistId', optionalAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID.' });

  const playlist = await getDb(`
    SELECT p.*, u.username, u.full_name, u.avatar_url,
      (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count
    FROM playlists p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND u.is_suspended = 0
  `, [playlistId]);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

  const access = await getPlaylistAccess(playlistId, req.user?.id || 0);
  if (!Number(playlist.is_public) && !access?.is_owner && !access?.is_collaborator) return res.status(403).json({ error: 'Esta playlist é privada.' });
  const collaborators = await allDb(`
    SELECT pc.id, pc.user_id, pc.status, pc.created_at, pc.responded_at,
      u.username, u.full_name, u.avatar_url,
      inviter.username AS invited_by_username, inviter.full_name AS invited_by_full_name
    FROM playlist_collaborators pc
    JOIN users u ON u.id = pc.user_id
    LEFT JOIN users inviter ON inviter.id = pc.invited_by_user_id
    WHERE pc.playlist_id = ?
      AND (UPPER(pc.status) = 'ACCEPTED' OR (? = 1 AND ? = ?))
    ORDER BY pc.status ASC, pc.created_at ASC, pc.id ASC
  `, [playlistId, access?.is_owner ? 1 : 0, access?.is_owner ? playlist.user_id : 0, playlist.user_id]);

  const tracks = await allDb(`
    SELECT pt.track_id, pt.sort_order, t.title AS track_title, t.duration, t.explicit,
      t.youtube_url, r.id AS release_id, r.title AS release_title, r.cover_url AS release_cover,
      a.name AS artist_name
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    JOIN releases r ON r.id = t.release_id
    JOIN artists a ON a.id = r.artist_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.sort_order ASC, pt.id ASC
  `, [playlistId]);

  return res.json({
    playlist,
    tracks,
    collaborators,
    permissions: access || { is_owner: false, is_collaborator: false, can_edit_tracks: false },
  });
});

app.post('/api/playlists', requireAuth, async (req, res) => {
  const { name, description, cover_url, is_public = true } = req.body;
  const playlistName = typeof name === 'string' ? name.trim() : '';
  const playlistDescription = typeof description === 'string' ? description.trim() : '';
  const playlistCover = typeof cover_url === 'string' ? cover_url.trim() : '';
  if (!playlistName) return res.status(400).json({ error: 'Playlist name is required.' });
  if (playlistName.length > 191 || playlistDescription.length > 2000 || !isValidImageUrl(playlistCover)) {
    return res.status(400).json({ error: 'Playlist details are invalid or too long.' });
  }

  let inviteIds;
  try {
    inviteIds = getPlaylistInviteIds(req.body.invite_user_ids);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  if (inviteIds.includes(Number(req.user.id))) {
    return res.status(400).json({ error: 'You cannot invite yourself to your own playlist.' });
  }
  let invitees = [];
  if (inviteIds.length) {
    invitees = await allDb(
      `SELECT id, username, full_name
       FROM users
       WHERE id IN (${inviteIds.map(() => '?').join(', ')})
         AND is_suspended = 0 AND is_approved = 1`,
      inviteIds
    );
    if (invitees.length !== inviteIds.length) {
      return res.status(400).json({ error: 'One or more selected people are no longer available.' });
    }
  }

  const inviter = invitees.length
    ? await getDb('SELECT username, full_name FROM users WHERE id = ?', [req.user.id])
    : null;
  const inviterName = inviter ? (inviter.full_name || inviter.username) : '';
  const connection = await db.getConnection();
  let playlistId;
  try {
    await connection.beginTransaction();
    const [playlistResult] = await connection.execute(
      'INSERT INTO playlists (user_id, name, description, cover_url, is_public) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, playlistName, playlistDescription, playlistCover, is_public ? 1 : 0]
    );
    playlistId = Number(playlistResult.insertId);
    await connection.execute(
      `INSERT INTO playlist_collaborators (playlist_id, user_id, invited_by_user_id, status)
       VALUES (?, ?, NULL, 'ACCEPTED')`,
      [playlistId, req.user.id]
    );
    for (const invitee of invitees) {
      const [collaborationResult] = await connection.execute(
        `INSERT INTO playlist_collaborators (playlist_id, user_id, invited_by_user_id, status)
         VALUES (?, ?, ?, 'PENDING')`,
        [playlistId, invitee.id, req.user.id]
      );
      await createNotificationOnConnection(
        connection,
        invitee.id,
        'PLAYLIST_INVITE',
        `${inviterName} convidou você para colaborar na playlist “${playlistName}”.`,
        `/playlists/${playlistId}`,
        req.user.id,
        Number(collaborationResult.insertId)
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return res.status(201).json({ message: 'Playlist created.', playlistId });
});

app.post('/api/playlists/:playlistId/collaborators', requireAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  const invitedUserId = parsePositiveId(req.body?.user_id);
  if (!playlistId || !invitedUserId) return res.status(400).json({ error: 'Playlist and user are required.' });

  const access = await getPlaylistAccess(playlistId, req.user.id);
  if (!access?.is_owner) return res.status(404).json({ error: 'Playlist not found.' });
  if (invitedUserId === Number(req.user.id)) {
    return res.status(400).json({ error: 'You cannot invite yourself to your own playlist.' });
  }

  const invitee = await getDb(
    'SELECT id, username, full_name FROM users WHERE id = ? AND is_suspended = 0 AND is_approved = 1',
    [invitedUserId]
  );
  if (!invitee) return res.status(400).json({ error: 'This person is no longer available.' });
  const playlist = await getDb('SELECT id, name FROM playlists WHERE id = ? AND user_id = ?', [playlistId, req.user.id]);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

  const existing = await getDb(
    'SELECT id, status FROM playlist_collaborators WHERE playlist_id = ? AND user_id = ?',
    [playlistId, invitedUserId]
  );
  if (existing && String(existing.status).toUpperCase() === 'ACCEPTED') {
    return res.status(409).json({ error: 'This person is already a collaborator.' });
  }
  if (existing && String(existing.status).toUpperCase() === 'PENDING') {
    return res.status(409).json({ error: 'There is already a pending invitation for this person.' });
  }

  const inviter = await getDb('SELECT username, full_name FROM users WHERE id = ?', [req.user.id]);
  const inviterName = inviter?.full_name || inviter?.username || 'Alguém';
  const connection = await db.getConnection();
  let collaboratorId;
  try {
    await connection.beginTransaction();
    if (existing) {
      await connection.execute(
        `UPDATE playlist_collaborators
         SET invited_by_user_id = ?, status = 'PENDING', created_at = CURRENT_TIMESTAMP, responded_at = NULL
         WHERE id = ? AND playlist_id = ? AND user_id = ?`,
        [req.user.id, existing.id, playlistId, invitedUserId]
      );
      collaboratorId = Number(existing.id);
    } else {
      const [collaboratorResult] = await connection.execute(
        `INSERT INTO playlist_collaborators (playlist_id, user_id, invited_by_user_id, status)
         VALUES (?, ?, ?, 'PENDING')`,
        [playlistId, invitedUserId, req.user.id]
      );
      collaboratorId = Number(collaboratorResult.insertId);
    }
    await createNotificationOnConnection(
      connection,
      invitedUserId,
      'PLAYLIST_INVITE',
      `${inviterName} convidou você para colaborar na playlist “${playlist.name}”.`,
      `/playlists/${playlistId}`,
      req.user.id,
      collaboratorId
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return res.status(201).json({ message: 'Invitation sent.', collaboratorId });
});

app.put('/api/playlists/:playlistId', requireAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID.' });
  const access = await getPlaylistAccess(playlistId, req.user.id);
  if (!access?.is_owner) return res.status(404).json({ error: 'Playlist not found.' });
  const { name, description, cover_url, is_public = true } = req.body;
  const playlistName = typeof name === 'string' ? name.trim() : '';
  const playlistDescription = typeof description === 'string' ? description.trim() : '';
  const playlistCover = typeof cover_url === 'string' ? cover_url.trim() : '';
  if (!playlistName) return res.status(400).json({ error: 'Playlist name is required.' });
  if (playlistName.length > 191 || playlistDescription.length > 2000 || !isValidImageUrl(playlistCover)) {
    return res.status(400).json({ error: 'Playlist details are invalid or too long.' });
  }

  await runDb(
    'UPDATE playlists SET name = ?, description = ?, cover_url = ?, is_public = ? WHERE id = ? AND user_id = ?',
    [playlistName, playlistDescription, playlistCover, is_public ? 1 : 0, playlistId, req.user.id]
  );
  return res.json({ message: 'Playlist updated.' });
});

app.delete('/api/playlists/:playlistId', requireAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID.' });
  const access = await getPlaylistAccess(playlistId, req.user.id);
  if (!access?.is_owner) return res.status(404).json({ error: 'Playlist not found.' });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [playlists] = await connection.execute(
      'SELECT id FROM playlists WHERE id = ? AND user_id = ? FOR UPDATE',
      [playlistId, req.user.id]
    );
    if (!playlists.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Playlist not found.' });
    }
    await connection.execute('DELETE FROM playlist_tracks WHERE playlist_id = ?', [playlistId]);
    await connection.execute('DELETE FROM playlists WHERE id = ? AND user_id = ?', [playlistId, req.user.id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return res.json({ message: 'Playlist deleted.' });
});

app.post('/api/playlists/:playlistId/tracks', requireAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  const trackId = parsePositiveId(req.body.track_id);
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID.' });
  if (!trackId) return res.status(400).json({ error: 'Track is required.' });

  const access = await getPlaylistAccess(playlistId, req.user.id);
  if (!access?.can_edit_tracks) return res.status(404).json({ error: 'Playlist not found.' });
  const track = await getDb('SELECT id FROM tracks WHERE id = ?', [trackId]);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const connection = await db.getConnection();
  let result;
  try {
    await connection.beginTransaction();
    await connection.execute('SELECT id FROM playlists WHERE id = ? FOR UPDATE', [playlistId]);
    const [sortRows] = await connection.execute(
      'SELECT sort_order FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [playlistId]
    );
    const nextOrder = sortRows.length ? Number(sortRows[0].sort_order) + 1 : 0;
    const [insertResult] = await connection.execute(
      'INSERT IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)',
      [playlistId, trackId, nextOrder]
    );
    result = { changes: Number(insertResult.affectedRows || 0) };
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return res.status(result.changes ? 201 : 200).json({ added: Boolean(result.changes) });
});

app.delete('/api/playlists/:playlistId/tracks/:trackId', requireAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  const trackId = parsePositiveId(req.params.trackId);
  if (!playlistId || !trackId) return res.status(400).json({ error: 'Invalid playlist or track ID.' });

  const access = await getPlaylistAccess(playlistId, req.user.id);
  if (!access?.can_edit_tracks) return res.status(404).json({ error: 'Playlist not found.' });
  const result = await runDb('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);
  if (!result.changes) return res.status(404).json({ error: 'Track not found in this playlist.' });
  return res.json({ message: 'Track removed from playlist.' });
});

app.put('/api/playlists/:playlistId/tracks/order', requireAuth, async (req, res) => {
  const playlistId = parsePositiveId(req.params.playlistId);
  const trackIds = req.body.track_ids;
  if (!playlistId) return res.status(400).json({ error: 'Invalid playlist ID.' });
  if (!Array.isArray(trackIds) || trackIds.some((id) => !parsePositiveId(id))) {
    return res.status(400).json({ error: 'Track order is invalid.' });
  }

  const access = await getPlaylistAccess(playlistId, req.user.id);
  if (!access?.can_edit_tracks) return res.status(404).json({ error: 'Playlist not found.' });
  const existingTracks = await allDb('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?', [playlistId]);
  const currentIds = existingTracks.map((row) => Number(row.track_id));
  const requestedIds = trackIds.map(Number);
  if (
    requestedIds.length !== currentIds.length
    || new Set(requestedIds).size !== requestedIds.length
    || currentIds.some((id) => !requestedIds.includes(id))
  ) {
    return res.status(400).json({ error: 'Track order must include every playlist track exactly once.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, trackId] of requestedIds.entries()) {
      await connection.execute(
        'UPDATE playlist_tracks SET sort_order = ? WHERE playlist_id = ? AND track_id = ?',
        [index, playlistId, trackId]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return res.json({ message: 'Playlist order updated.' });
});

app.post('/api/favorites/:trackId', requireAuth, async (req, res) => {
  const existing = await getDb('SELECT id FROM favorites WHERE user_id = ? AND track_id = ?', [req.user.id, req.params.trackId]);
  if (existing) {
    await runDb('DELETE FROM favorites WHERE id = ?', [existing.id]);
    return res.json({ favorite: false });
  }

  await runDb('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)', [req.user.id, req.params.trackId]);
  return res.json({ favorite: true });
});

const resetCatalogHandler = async (req, res) => {
  try {
    await runDb('DELETE FROM review_likes');
    await runDb('DELETE FROM playlist_tracks');
    await runDb('DELETE FROM favorites');
    await runDb('DELETE FROM pre_saves');
    await runDb('DELETE FROM notifications');
    await runDb('DELETE FROM featured_releases');
    await runDb('DELETE FROM reviews');
    await runDb('DELETE FROM tracks');
    await runDb('DELETE FROM releases');
    await runDb('DELETE FROM artist_genres');
    await runDb('DELETE FROM artists');

    return res.json({ message: 'Catálogo zerado com sucesso.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Não foi possível limpar o catálogo.' });
  }
};

app.post('/api/admin/reset-catalog', requireAuth, requireAdmin, resetCatalogHandler);
app.post('/api/admin/reset', requireAuth, requireAdmin, resetCatalogHandler);
app.post('/api/admin/catalog/reset', requireAuth, requireAdmin, resetCatalogHandler);

app.get('/api/admin/featured', requireAuth, requireAdmin, async (req, res) => {
  const featured = await allDb(`
    SELECT fr.id, fr.release_id, fr.sort_order, fr.banner_url, fr.description,
      r.title, r.cover_url, r.status, a.name AS artist_name
    FROM featured_releases fr
    JOIN releases r ON r.id = fr.release_id
    JOIN artists a ON a.id = r.artist_id
    ORDER BY fr.sort_order ASC, fr.id ASC
  `);
  return res.json(featured);
});

app.post('/api/admin/featured', requireAuth, requireAdmin, async (req, res) => {
  const { release_id, sort_order, banner_url, description } = req.body;
  const releaseId = Number(release_id);
  const order = Number(sort_order);
  const bannerUrl = typeof banner_url === 'string' ? banner_url.trim() : '';
  const featuredDescription = typeof description === 'string' ? description.trim() : '';

  if (!Number.isSafeInteger(releaseId) || releaseId < 1) {
    return res.status(400).json({ error: 'Selecione um lançamento para destacar.' });
  }
  if (!bannerUrl || !isValidImageUrl(bannerUrl)) {
    return res.status(400).json({ error: 'Escolha ou carregue um banner válido para o destaque.' });
  }
  if (!featuredDescription || featuredDescription.length > 600) {
    return res.status(400).json({ error: 'Escreva uma descrição de até 600 caracteres para o destaque.' });
  }
  if (!Number.isSafeInteger(order) || order < 1) {
    return res.status(400).json({ error: 'A ordem do destaque deve ser um número inteiro positivo.' });
  }

  const release = await getDb('SELECT id FROM releases WHERE id = ?', [releaseId]);
  if (!release) {
    return res.status(404).json({ error: 'Lançamento não encontrado.' });
  }

  const existing = await getDb('SELECT id FROM featured_releases WHERE release_id = ?', [releaseId]);

  if (existing) {
    await runDb(
      'UPDATE featured_releases SET sort_order = ?, banner_url = ?, description = ? WHERE id = ?',
      [order, bannerUrl, featuredDescription, existing.id]
    );
    return res.json({ message: 'Destaque atualizado.' });
  }

  await runDb(
    'INSERT INTO featured_releases (release_id, sort_order, banner_url, description) VALUES (?, ?, ?, ?)',
    [releaseId, order, bannerUrl, featuredDescription]
  );
  return res.status(201).json({ message: 'Destaque criado.' });
});

app.delete('/api/admin/featured/:featuredId', requireAuth, requireAdmin, async (req, res) => {
  const featuredId = Number(req.params.featuredId);
  if (!Number.isSafeInteger(featuredId) || featuredId < 1) {
    return res.status(400).json({ error: 'Destaque inválido.' });
  }

  const featured = await getDb('SELECT id FROM featured_releases WHERE id = ?', [featuredId]);
  if (!featured) {
    return res.status(404).json({ error: 'Destaque não encontrado.' });
  }

  await runDb('DELETE FROM featured_releases WHERE id = ?', [featuredId]);
  return res.json({ message: 'Destaque removido do carrossel.' });
});

app.get('/api/admin/settings/profile-approval', requireAuth, requireAdmin, async (req, res) => {
  const setting = await getDb(
    'SELECT setting_value FROM app_settings WHERE setting_key = ?',
    ['require_profile_approval']
  );
  if (!setting) {
    return res.status(503).json({ error: 'Registration settings are unavailable.' });
  }
  return res.json({ enabled: setting.setting_value === '1' });
});

app.put('/api/admin/settings/profile-approval', requireAuth, requireAdmin, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'Informe se a aprovação de perfis deve ficar ativada.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [settingRows] = await connection.execute(
      'SELECT setting_value FROM app_settings WHERE setting_key = ? FOR UPDATE',
      ['require_profile_approval']
    );
    if (!settingRows[0]) {
      await connection.rollback();
      return res.status(503).json({ error: 'Registration settings are unavailable.' });
    }

    await connection.execute(
      `UPDATE app_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?`,
      [req.body.enabled ? '1' : '0', 'require_profile_approval']
    );

    let approvedCount = 0;
    if (!req.body.enabled) {
      await connection.execute(`
        INSERT INTO notifications (user_id, type, actor_user_id, message, link_url)
        SELECT id, 'ACCOUNT_APPROVED', ?, ?, '/'
        FROM users
        WHERE \`role\` = 'USER' AND is_approved = 0
      `, [
        req.user.id,
        'A aprovação manual de perfis foi desativada. Sua conta foi liberada para participar do Musicfy.',
      ]);
      const [result] = await connection.execute(
        `UPDATE users SET is_approved = 1, updated_at = CURRENT_TIMESTAMP WHERE \`role\` = 'USER' AND is_approved = 0`
      );
      approvedCount = Number(result.affectedRows || 0);
    }

    await connection.commit();
    return res.json({ enabled: req.body.enabled, approved_count: approvedCount });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back profile approval settings:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const approvalFilter = req.query.approval === 'pending' ? 'AND is_approved = 0' : '';
  const users = await allDb(`
    SELECT id, username, full_name, email, avatar_url, bio, is_suspended, is_approved, created_at
    FROM users
    WHERE \`role\` = 'USER'
      ${approvalFilter}
    ORDER BY is_approved ASC, is_suspended ASC, created_at DESC, id DESC
    LIMIT 200
  `);
  return res.json(users.map((user) => ({
    ...user,
    is_suspended: Boolean(Number(user.is_suspended)),
    is_approved: Boolean(Number(user.is_approved)),
  })));
});

app.post('/api/admin/users/:userId/approve', requireAuth, requireAdmin, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'User ID is invalid.' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id, `role`, is_approved FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    const target = rows[0];
    if (!target) {
      await connection.rollback();
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.role !== 'USER') {
      await connection.rollback();
      return res.status(403).json({ error: 'Only standard user profiles can be approved.' });
    }
    if (Number(target.is_approved)) {
      await connection.rollback();
      return res.json({ is_approved: true, changed: false });
    }

    await connection.execute(
      'UPDATE users SET is_approved = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [userId]
    );
    await connection.execute(
      'INSERT INTO notifications (user_id, type, actor_user_id, message, link_url) VALUES (?, ?, ?, ?, ?)',
      [
        userId,
        'ACCOUNT_APPROVED',
        req.user.id,
        'Sua conta foi aprovada. Atualize a página para começar a participar do Musicfy.',
        '/',
      ]
    );
    await connection.commit();
    return res.json({ is_approved: true, changed: true });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back profile approval:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
});

app.delete('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'User ID is invalid.' });
  if (userId === Number(req.user.id)) {
    return res.status(400).json({ error: 'Administrators cannot suspend their own account.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id, `role`, is_suspended FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    const target = rows[0];
    if (!target) {
      await connection.rollback();
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.role !== 'USER') {
      await connection.rollback();
      return res.status(403).json({ error: 'Only standard user profiles can be suspended.' });
    }
    if (Number(target.is_suspended)) {
      await connection.rollback();
      return res.json({ is_suspended: true, changed: false });
    }

    await connection.execute('UPDATE users SET is_suspended = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    await connection.execute(
      'INSERT INTO notifications (user_id, type, actor_user_id, message) VALUES (?, ?, ?, ?)',
      [
        userId,
        'ACCOUNT_SUSPENDED',
        req.user.id,
        'Seu perfil foi ocultado pela equipe administrativa. Você pode acessar apenas suas notificações.',
      ]
    );
    await connection.commit();
    return res.json({ is_suspended: true, changed: true });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back profile suspension:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
});

app.post('/api/admin/users/:userId/restore', requireAuth, requireAdmin, async (req, res) => {
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'User ID is invalid.' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id, `role`, is_suspended FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    const target = rows[0];
    if (!target) {
      await connection.rollback();
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.role !== 'USER') {
      await connection.rollback();
      return res.status(403).json({ error: 'Only standard user profiles can be restored.' });
    }
    if (!Number(target.is_suspended)) {
      await connection.rollback();
      return res.json({ is_suspended: false, changed: false });
    }

    await connection.execute('UPDATE users SET is_suspended = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    await connection.execute(
      'INSERT INTO notifications (user_id, type, actor_user_id, message) VALUES (?, ?, ?, ?)',
      [userId, 'ACCOUNT_RESTORED', req.user.id, 'Seu perfil foi reativado pela equipe administrativa.']
    );
    await connection.commit();
    return res.json({ is_suspended: false, changed: true });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back profile restoration:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
});

app.get('/api/admin/reviews', requireAuth, requireAdmin, async (req, res) => {
  const reviews = await allDb(`
    SELECT rv.id, rv.user_id, rv.rating, rv.review_text, rv.created_at,
      rm.gif_url, u.username, u.full_name, r.title AS release_title,
      r.cover_url AS release_cover, a.name AS artist_name
    FROM reviews rv
    JOIN users u ON u.id = rv.user_id
    JOIN releases r ON r.id = rv.release_id
    JOIN artists a ON a.id = r.artist_id
    LEFT JOIN review_media rm ON rm.review_id = rv.id
    ORDER BY rv.created_at DESC, rv.id DESC
    LIMIT 200
  `);
  return res.json(reviews);
});

app.get('/api/dashboard', requireAuth, requireAdmin, async (req, res) => {
  const stats = {
    artists: await getDb('SELECT COUNT(*) AS count FROM artists'),
    releases: await getDb('SELECT COUNT(*) AS count FROM releases'),
    users: await getDb('SELECT COUNT(*) AS count FROM users'),
    reviews: await getDb('SELECT COUNT(*) AS count FROM reviews'),
  };
  return res.json(stats);
});

app.use((error, req, res, next) => {
  console.error(`Unhandled request error (${req.method} ${req.path}):`, error);
  if (res.headersSent) return next(error);

  const status = Number(error.status || error.statusCode);
  const isClientError = Number.isInteger(status) && status >= 400 && status < 500;
  const message = isClientError && typeof error.message === 'string'
    ? error.message
    : 'Erro interno no servidor. Consulte os logs do Render.';
  return res.status(isClientError ? status : 500).json({ error: message });
});

const distPath = path.join(__dirname, '..', 'dist');
const serveClient = process.env.NODE_ENV === 'production' && fs.existsSync(distPath);
if (serveClient) {
  app.use(express.static(distPath));
}

app.use((req, res) => {
  if (
    serveClient
    && ['GET', 'HEAD'].includes(req.method)
    && !req.path.startsWith('/api')
    && !path.extname(req.path)
  ) {
    return res.sendFile(path.join(distPath, 'index.html'));
  }
  return res.status(404).json({ error: 'Route not found.' });
});

async function startServer() {
  await initializeDatabase();
  await publishDueReleases();
  app.listen(PORT, () => {
    console.log(`Musicfy API listening on http://localhost:${PORT}`);
  });
  const releasePublisher = setInterval(() => {
    publishDueReleases().catch((error) => console.error('Failed to publish scheduled releases:', error));
  }, 60000);
  releasePublisher.unref();
}

startServer().catch((error) => {
  console.error('Failed to start Musicfy API:', error);
  process.exitCode = 1;
});
