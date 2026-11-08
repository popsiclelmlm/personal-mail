-- 地址保留期：临时 / 长期 / 永久
-- 已经部署过本仓库旧版本（2026-06 的保留期功能）的数据库已有这三列，跳过本文件
ALTER TABLE address ADD COLUMN retention_type TEXT DEFAULT 'temporary';
ALTER TABLE address ADD COLUMN retention_until DATETIME;
ALTER TABLE address ADD COLUMN is_permanent INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_address_is_permanent ON address(is_permanent);
