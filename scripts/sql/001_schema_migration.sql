-- =====================================================================
-- 001_schema_migration.sql
-- 人员主档案表结构迁移：新增 创建时间/修改时间 字段 + 关系/创建时间索引
--
-- 变更点（对应需求「人员列表 1.2」）：
--   1) fj_id_card 增加 created_at（新增时间）/ updated_at（修改时间）
--   2) 增加 idx_relation 索引（关系实时聚合 / 列表按关系筛选）
--   3) 增加 idx_created_at 索引（看板「本年新增」统计）
--
-- 说明：历史存量行的 created_at/updated_at 将回填为执行迁移的时间点，
--       「本年新增」仅统计迁移后新增的人员（属预期行为）。
--
-- 生产同步：执行本脚本前先备份（mysqldump infocard fj_id_card --no-data）
-- =====================================================================

ALTER TABLE fj_id_card
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间(新增时间)' AFTER remark,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间' AFTER created_at,
  ADD KEY idx_relation (relation),
  ADD KEY idx_created_at (created_at);
