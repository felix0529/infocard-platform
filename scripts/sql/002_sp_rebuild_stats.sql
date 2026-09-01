-- =====================================================================
-- 002_sp_rebuild_stats.sql
-- 看板预聚合统计表全量重建存储过程（数据层重建）
--
-- 需求对应（看板统计方案 3.2）：清空统计表、全量重建转到数据层（SQL 存储过程）；
-- 增量维护保留在应用层（server/db.js 的 statsAdjust 不变）。
--
-- 口径变更（相对旧 rebuild-stats.js）：
--   1) 移除 regyear 维度与 yrXXXX 范围（看板已去掉「记录年份」筛选）
--   2) 新增 cy@<scope> 维度（按创建年份计数），供关键指标「本年新增」
--   3) relation@<scope> 仅保留 __null__（无关系）计数：
--      无关系人数走统计表，有关系人数由应用层实时聚合（idx_relation 索引，约数百行）
--   4) c@<scope> 的 hasrec/norec 以「是否存在 cdsgus 记录」为准（与看板/列表口径一致）
--
-- 使用：
--   mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard_test < scripts/sql/002_sp_rebuild_stats.sql
--   CALL sp_rebuild_id_card_stats();
--
-- 生产同步：同一脚本在正式库执行（先备份），再 CALL sp_rebuild_id_card_stats() 重建。
-- 注意：必须保证客户端以 utf8mb4 连接（--default-character-set=utf8mb4），
--       否则存储过程内的中文常量（年龄阶段、未知等）会以错误字符集写入，导致看板乱码。
-- =====================================================================

SET NAMES utf8mb4;

DROP PROCEDURE IF EXISTS sp_rebuild_id_card_stats;

DELIMITER $$

CREATE PROCEDURE sp_rebuild_id_card_stats()
BEGIN
  TRUNCATE TABLE fj_id_card_stats;

  -- 派生基表：一次扫描得到每行全部维度取值（含是否有 cdsgus 记录）
  CREATE TEMPORARY TABLE tmp_stats_base AS
  SELECT
    f.id,
    EXISTS(SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no) AS has_rec,
    f.gender_code                                            AS gender,
    CASE WHEN f.name IS NOT NULL AND f.name <> '' THEN LEFT(f.name, 1) END AS surname,
    LEFT(f.region_code, 2)                                   AS region2,
    CASE WHEN f.birth_date_str IS NOT NULL AND f.birth_date_str <> ''
         THEN LEFT(f.birth_date_str, 4) END                  AS birthyear,
    CASE WHEN f.birth_date_str IS NOT NULL
         THEN SUBSTRING(f.birth_date_str, 5, 2) END          AS birthmonth,
    c.name                                                   AS constellation,
    CASE WHEN f.birth_date_str IS NOT NULL AND f.birth_date_str <> ''
         THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(f.birth_date_str, '%Y%m%d'), CURDATE()) END AS age,
    f.relation                                               AS relation,
    YEAR(f.created_at)                                       AS cy,
    (f.mobile IS NOT NULL AND TRIM(f.mobile) <> '')          AS has_mob,
    CASE WHEN f.mobile IS NOT NULL AND TRIM(f.mobile) <> ''
         THEN COALESCE(NULLIF(m.province, ''), '未知') END   AS mprov,
    CASE WHEN f.mobile IS NOT NULL AND TRIM(f.mobile) <> ''
         THEN COALESCE(NULLIF(m.carrier, ''), '未知') END    AS mcarrier
  FROM fj_id_card f
  LEFT JOIN fj_constellation c ON f.birth_mmdd IS NOT NULL
       AND ((c.start_mmdd <= c.end_mmdd AND f.birth_mmdd BETWEEN c.start_mmdd AND c.end_mmdd)
         OR (c.start_mmdd > c.end_mmdd AND (f.birth_mmdd >= c.start_mmdd OR f.birth_mmdd <= c.end_mmdd)))
  LEFT JOIN fj_mobile_segment m ON LEFT(f.mobile, 7) = m.segment;

  -- ==================== c：人员计数 ====================
  -- 注意：MySQL 临时表单条语句只能被引用一次，故每行单独一条 INSERT
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@all', 'total',  COUNT(*) FROM tmp_stats_base;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@all', 'hasrec', COUNT(*) FROM tmp_stats_base WHERE has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@all', 'norec',  COUNT(*) FROM tmp_stats_base WHERE NOT has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@rec1', 'total', COUNT(*) FROM tmp_stats_base WHERE has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@rec1', 'hasrec',COUNT(*) FROM tmp_stats_base WHERE has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@rec0', 'total', COUNT(*) FROM tmp_stats_base WHERE NOT has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'c@rec0', 'norec', COUNT(*) FROM tmp_stats_base WHERE NOT has_rec;

  -- ==================== gender：性别 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'gender@all', IFNULL(CAST(gender AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base GROUP BY gender;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'gender@rec1', IFNULL(CAST(gender AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE has_rec GROUP BY gender;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'gender@rec0', IFNULL(CAST(gender AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE NOT has_rec GROUP BY gender;

  -- ==================== surname：姓氏 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'surname@all', surname, COUNT(*) FROM tmp_stats_base WHERE surname IS NOT NULL GROUP BY surname;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'surname@rec1', surname, COUNT(*) FROM tmp_stats_base WHERE has_rec AND surname IS NOT NULL GROUP BY surname;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'surname@rec0', surname, COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND surname IS NOT NULL GROUP BY surname;

  -- ==================== region2：省前缀 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'region2@all', region2, COUNT(*) FROM tmp_stats_base WHERE region2 IS NOT NULL GROUP BY region2;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'region2@rec1', region2, COUNT(*) FROM tmp_stats_base WHERE has_rec AND region2 IS NOT NULL GROUP BY region2;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'region2@rec0', region2, COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND region2 IS NOT NULL GROUP BY region2;

  -- ==================== birthyear / birthmonth：出生年份 / 月份 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'birthyear@all', birthyear, COUNT(*) FROM tmp_stats_base WHERE birthyear IS NOT NULL GROUP BY birthyear;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'birthyear@rec1', birthyear, COUNT(*) FROM tmp_stats_base WHERE has_rec AND birthyear IS NOT NULL GROUP BY birthyear;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'birthyear@rec0', birthyear, COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND birthyear IS NOT NULL GROUP BY birthyear;

  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'birthmonth@all', birthmonth, COUNT(*) FROM tmp_stats_base WHERE birthmonth IS NOT NULL GROUP BY birthmonth;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'birthmonth@rec1', birthmonth, COUNT(*) FROM tmp_stats_base WHERE has_rec AND birthmonth IS NOT NULL GROUP BY birthmonth;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'birthmonth@rec0', birthmonth, COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND birthmonth IS NOT NULL GROUP BY birthmonth;

  -- ==================== constellation：星座 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'constellation@all', IFNULL(constellation, '__null__'), COUNT(*) FROM tmp_stats_base GROUP BY constellation;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'constellation@rec1', IFNULL(constellation, '__null__'), COUNT(*) FROM tmp_stats_base WHERE has_rec GROUP BY constellation;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'constellation@rec0', IFNULL(constellation, '__null__'), COUNT(*) FROM tmp_stats_base WHERE NOT has_rec GROUP BY constellation;

  -- ==================== relation：仅无关系（__null__） ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'relation@all', '__null__', COUNT(*) FROM tmp_stats_base WHERE relation IS NULL;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'relation@rec1', '__null__', COUNT(*) FROM tmp_stats_base WHERE has_rec AND relation IS NULL;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'relation@rec0', '__null__', COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND relation IS NULL;

  -- ==================== age / agestage：年龄 / 年龄阶段 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'age@all', IFNULL(CAST(age AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE age IS NOT NULL GROUP BY age;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'age@rec1', IFNULL(CAST(age AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE has_rec AND age IS NOT NULL GROUP BY age;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'age@rec0', IFNULL(CAST(age AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND age IS NOT NULL GROUP BY age;

  -- agestage：按阶段标签分组（多个 age 映射到同一阶段），避免重复主键
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'agestage@all', stage, COUNT(*) FROM (
    SELECT CASE WHEN age <= 6  THEN '幼儿（0-6岁）'
                WHEN age <= 12 THEN '少儿（7-12岁）'
                WHEN age <= 17 THEN '少年（13-17岁）'
                WHEN age <= 35 THEN '青年（18-35岁）'
                WHEN age <= 50 THEN '中年（36-50岁）'
                WHEN age <= 65 THEN '老年（51-65岁）'
                ELSE '高龄（65岁以上）' END AS stage
    FROM tmp_stats_base WHERE age IS NOT NULL
  ) t GROUP BY stage;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'agestage@rec1', stage, COUNT(*) FROM (
    SELECT CASE WHEN age <= 6  THEN '幼儿（0-6岁）'
                WHEN age <= 12 THEN '少儿（7-12岁）'
                WHEN age <= 17 THEN '少年（13-17岁）'
                WHEN age <= 35 THEN '青年（18-35岁）'
                WHEN age <= 50 THEN '中年（36-50岁）'
                WHEN age <= 65 THEN '老年（51-65岁）'
                ELSE '高龄（65岁以上）' END AS stage
    FROM tmp_stats_base WHERE has_rec AND age IS NOT NULL
  ) t GROUP BY stage;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'agestage@rec0', stage, COUNT(*) FROM (
    SELECT CASE WHEN age <= 6  THEN '幼儿（0-6岁）'
                WHEN age <= 12 THEN '少儿（7-12岁）'
                WHEN age <= 17 THEN '少年（13-17岁）'
                WHEN age <= 35 THEN '青年（18-35岁）'
                WHEN age <= 50 THEN '中年（36-50岁）'
                WHEN age <= 65 THEN '老年（51-65岁）'
                ELSE '高龄（65岁以上）' END AS stage
    FROM tmp_stats_base WHERE NOT has_rec AND age IS NOT NULL
  ) t GROUP BY stage;

  -- ==================== cy：创建年份（本年新增） ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'cy@all', IFNULL(CAST(cy AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base GROUP BY cy;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'cy@rec1', IFNULL(CAST(cy AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE has_rec GROUP BY cy;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'cy@rec0', IFNULL(CAST(cy AS CHAR), '__null__'), COUNT(*) FROM tmp_stats_base WHERE NOT has_rec GROUP BY cy;

  -- ==================== m：手机计数 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@all', 'total',   COUNT(*) FROM tmp_stats_base;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@all', 'withmob', COUNT(*) FROM tmp_stats_base WHERE has_mob;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@all', 'nomob',   COUNT(*) FROM tmp_stats_base WHERE NOT has_mob;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@rec1', 'total',   COUNT(*) FROM tmp_stats_base WHERE has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@rec1', 'withmob', COUNT(*) FROM tmp_stats_base WHERE has_rec AND has_mob;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@rec1', 'nomob',   COUNT(*) FROM tmp_stats_base WHERE has_rec AND NOT has_mob;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@rec0', 'total',   COUNT(*) FROM tmp_stats_base WHERE NOT has_rec;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@rec0', 'withmob', COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND has_mob;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt) SELECT 'm@rec0', 'nomob',   COUNT(*) FROM tmp_stats_base WHERE NOT has_rec AND NOT has_mob;

  -- ==================== mprov / mcarrier：手机归属地 / 运营商 ====================
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'mprov@all', IFNULL(mprov, '__null__'), COUNT(*) FROM tmp_stats_base GROUP BY mprov;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'mprov@rec1', IFNULL(mprov, '__null__'), COUNT(*) FROM tmp_stats_base WHERE has_rec GROUP BY mprov;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'mprov@rec0', IFNULL(mprov, '__null__'), COUNT(*) FROM tmp_stats_base WHERE NOT has_rec GROUP BY mprov;

  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'mcarrier@all', IFNULL(mcarrier, '__null__'), COUNT(*) FROM tmp_stats_base GROUP BY mcarrier;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'mcarrier@rec1', IFNULL(mcarrier, '__null__'), COUNT(*) FROM tmp_stats_base WHERE has_rec GROUP BY mcarrier;
  INSERT INTO fj_id_card_stats (dim, bucket, cnt)
  SELECT 'mcarrier@rec0', IFNULL(mcarrier, '__null__'), COUNT(*) FROM tmp_stats_base WHERE NOT has_rec GROUP BY mcarrier;

  DROP TEMPORARY TABLE IF EXISTS tmp_stats_base;
END$$

DELIMITER ;
