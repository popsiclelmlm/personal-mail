-- 个人邮箱：邮箱凭证版本（重置凭证时加 1）与「禁止邮箱凭证登录」开关
ALTER TABLE address ADD COLUMN credential_version INTEGER DEFAULT 0;
ALTER TABLE address ADD COLUMN credential_login_disabled INTEGER DEFAULT 0;
