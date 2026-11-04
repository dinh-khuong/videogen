// Hệ migration cũ (đánh số bằng PRAGMA user_version), ĐÃ ĐÓNG BĂNG: chỉ còn dùng để đưa database tạo từ bản cũ lên đúng schema
// nền của Drizzle (drizzle/0000_baseline.sql) trước khi đánh dấu baseline đã áp dụng, xem db.ts. Không sửa, không thêm bước mới:
// thay đổi schema từ nay làm trong schema.ts rồi `npm run db:generate`.
/** Bước thứ N (đếm từ 1) đưa user_version từ N-1 lên N. */
export const LEGACY_MIGRATIONS: string[] = [
  `
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    thumbnail TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'upload',
    source_url TEXT,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER,
    sha1 TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'lead',
    source TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    follow_up_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    topic TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT,
    message TEXT,
    error TEXT,
    video_id TEXT,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    pid INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX jobs_status ON jobs(status, created_at);

  CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    thumbnail TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'generated',
    duration REAL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER,
    script TEXT,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE video_images (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    step INTEGER NOT NULL,
    PRIMARY KEY (video_id, step)
  );
  CREATE INDEX video_images_image ON video_images(image_id);

  CREATE TABLE image_tags (
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, tag_id)
  );
  CREATE TABLE video_tags (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, tag_id)
  );
  CREATE TABLE contact_tags (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (contact_id, tag_id)
  );

  CREATE TABLE contact_activities (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'note',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX contact_activities_contact ON contact_activities(contact_id, created_at);

  CREATE TABLE contact_videos (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (contact_id, video_id)
  );
  `,
  // Thư viện ảnh -> thư viện asset (ảnh hoặc video dùng để ghép vào video), có kết quả phân tích OCR + AI.
  // Video tải lên trước đây (vd gameplay làm nền) chuyển sang asset, giữ nguyên id và file.
  `
  ALTER TABLE images RENAME TO assets;
  ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
  ALTER TABLE assets ADD COLUMN duration REAL;
  ALTER TABLE assets ADD COLUMN ocr_text TEXT NOT NULL DEFAULT '';
  ALTER TABLE assets ADD COLUMN ai_summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE assets ADD COLUMN ai_tags TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE assets ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE assets ADD COLUMN analysis_error TEXT;
  ALTER TABLE assets ADD COLUMN analyzed_at TEXT;
  CREATE INDEX assets_analysis ON assets(analysis_status, created_at);

  ALTER TABLE image_tags RENAME TO asset_tags;
  ALTER TABLE asset_tags RENAME COLUMN image_id TO asset_id;
  ALTER TABLE video_images RENAME TO video_assets;
  ALTER TABLE video_assets RENAME COLUMN image_id TO asset_id;
  DROP INDEX video_images_image;
  CREATE INDEX video_assets_asset ON video_assets(asset_id);

  INSERT INTO assets (id, file, thumbnail, title, description, source, kind, duration, width, height, size_bytes, created_at, updated_at)
    SELECT id, file, thumbnail, title, description, 'upload', 'video', duration, width, height, size_bytes, created_at, updated_at
    FROM videos WHERE kind = 'upload';
  INSERT OR IGNORE INTO asset_tags (asset_id, tag_id)
    SELECT vt.video_id, vt.tag_id FROM video_tags vt JOIN videos v ON v.id = vt.video_id WHERE v.kind = 'upload';
  DELETE FROM videos WHERE kind = 'upload';
  `,
  // Một bước có thể ghép nhiều asset nối tiếp (vd nhiều clip video): thêm thứ tự trong bước vào khóa chính
  `
  CREATE TABLE video_assets_new (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    step INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (video_id, step, position)
  );
  INSERT INTO video_assets_new (video_id, asset_id, step, position) SELECT video_id, asset_id, step, 0 FROM video_assets;
  DROP TABLE video_assets;
  ALTER TABLE video_assets_new RENAME TO video_assets;
  CREATE INDEX video_assets_asset ON video_assets(asset_id);
  `,
  // Thư mục asset: mỗi asset nằm trong tối đa một thư mục; xóa thư mục thì asset về "Chưa phân loại"
  `
  CREATE TABLE asset_folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  ALTER TABLE assets ADD COLUMN folder_id TEXT REFERENCES asset_folders(id) ON DELETE SET NULL;
  CREATE INDEX assets_folder ON assets(folder_id, created_at);
  `,
  // Thư mục lồng nhau kiểu Drive: thư mục cha (NULL = gốc), màu và gắn sao
  `
  ALTER TABLE asset_folders ADD COLUMN parent_id TEXT REFERENCES asset_folders(id) ON DELETE CASCADE;
  ALTER TABLE asset_folders ADD COLUMN color TEXT;
  ALTER TABLE asset_folders ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX asset_folders_parent ON asset_folders(parent_id);
  `,
  // Thời gian chạy job: lưu thời gian thực tế khi job kết thúc, và ước tính khi tạo job (dựa vào lịch sử job tương tự)
  `
  ALTER TABLE jobs ADD COLUMN duration_seconds REAL;
  ALTER TABLE jobs ADD COLUMN estimated_seconds REAL;
  `,
  // Token/API key của các dịch vụ (AI, giọng đọc, tìm ảnh...): mỗi dịch vụ có thể lưu nhiều token, một cái đang dùng
  // (active) được truyền cho engine khi chạy job. last_* là kết quả lần kiểm tra token gần nhất.
  `
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    last_status TEXT,
    last_message TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX api_tokens_provider ON api_tokens(provider, active);
  `,
  // Thiết lập đi kèm token (model, địa chỉ API...) dạng JSON { khóa: giá trị }
  `ALTER TABLE api_tokens ADD COLUMN options TEXT NOT NULL DEFAULT '{}';`,
];
