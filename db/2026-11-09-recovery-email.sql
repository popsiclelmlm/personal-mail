-- 辅助邮箱：用个人邮箱注册的账号用它找回密码（可选）
-- 也可以在管理后台点「迁移数据库」自动补齐
ALTER TABLE users ADD COLUMN recovery_email TEXT;
