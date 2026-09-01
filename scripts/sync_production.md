# 生产环境同步步骤

> 本次变更同步内容：人员列表（无关系计数、回车检索）+ 数据看板（占比、乱码修复、手机统计）
> 测试环境已验证通过（infocard_test / 5173），本步骤用于同步生产（infocard / 5174）。

## 同步范围

| 类型 | 内容 | 是否需要重启服务 |
|---|---|---|
| 数据库 | `001_schema_migration.sql`（表结构）、`002_sp_rebuild_stats.sql`（存储过程） | 否 |
| 前端静态 | `public/app.js`、`public/dashboard.js`、`public/styles.css` | 否（热加载） |

生产服务托管同一份 `CARD/public` 目录，**前端改动无需部署**；数据库变更按下面步骤执行。

> ⚠️ **后端代码注意**：若本次变更还涉及 `server/` 下的后端代码（如 `db.js`），**前端热加载不生效**，必须重启对应服务加载新代码：
> ```bash
> scripts/start-services.sh stop:prod && scripts/start-services.sh start:prod   # 重启生产(5174)
> ```
> 验证方式：重启前调用 `GET /api/dashboard/stats`，比对 `counts` 是否含本次新增字段（如 male/female/newThisYear）。

> 以下命令中数据库密码用 `******` 占位，请替换为生产库实际密码（见 `.env.prod`）。

---

## 第 1 步：备份生产库（必做，防止意外）

```bash
mkdir -p ~/backup

# 表结构备份（ALTER TABLE 前必须做）
mysqldump --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard fj_id_card --no-data \
  > ~/backup/prod_fj_id_card_schema_$(date +%Y%m%d_%H%M%S).sql

# 统计表备份（重建前可留底，便于回滚对比）
mysqldump --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard fj_id_card_stats \
  > ~/backup/prod_fj_id_card_stats_$(date +%Y%m%d_%H%M%S).sql
```

> 若生产库数据量大，`ALTER TABLE` 会锁表耗时，**请选择低峰期执行**。

---

## 第 2 步：执行表结构迁移（001）

```bash
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard < scripts/sql/001_schema_migration.sql
```

作用：给 `fj_id_card` 增加 `created_at` / `updated_at` 字段，并加 `idx_relation`、`idx_created_at` 索引（支撑看板"本年新增"与关系实时聚合）。

> 幂等说明：若生产库此前已执行过该脚本，会报"Duplicate column name"错误，属正常，说明迁移已存在，可跳过。

---

## 第 3 步：部署统计表重建存储过程（002）

```bash
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard < scripts/sql/002_sp_rebuild_stats.sql
```

> ⚠️ **关键**：必须带 `--default-character-set=utf8mb4`。本次看板乱码的根因就是存储过程内中文常量（年龄阶段"幼儿（0-6岁）"、"未知"等）以错误字符集写入。脚本内已含 `SET NAMES utf8mb4;`，执行时连接字符集必须一致。

---

## 第 4 步：重建统计表（全量）

```bash
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard -e "CALL sp_rebuild_id_card_stats();"
```

作用：清空并全量重建 `fj_id_card_stats`，确保中文标签正确、`__null__`/无关系口径与测试环境一致。

---

## 第 5 步：验证生产

浏览器打开生产服务 `http://localhost:5174/`，逐项核对：

| 检查项 | 预期 |
|---|---|
| 看板统计卡 | 总人数 / 男性（占比）/ 女性（占比）/ 本年新增（占比） |
| 年龄阶段图 | 横坐标中文正常两行显示（如"青年（18-35岁）"），无乱码 |
| 手机统计卡 | 总人数 / 已记录手机号（占比）/ 待补手机号（占比） |
| 运营商 / 归属地图 | 图例中文正常、无乱码、不含 `__null__`（"未知"可保留） |
| 人员列表 | 「无关系」chip 带计数、其余关系 chip 无计数；搜索按回车才触发 |

另可用命令抽查生产库统计表标签是否正常：

```bash
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -utrae -p****** infocard \
  -e "SELECT dim,bucket,cnt FROM fj_id_card_stats WHERE dim='agestage@all';"
```

---

## 第 6 步：回滚方案（如出问题）

- **表结构/数据异常**：恢复第 1 步备份
  ```bash
  mysql -h127.0.0.1 -P3306 -utrae -p****** infocard < ~/backup/prod_fj_id_card_schema_*.sql
  ```
- **统计表异常**：无需恢复备份，直接重跑第 4 步 `CALL sp_rebuild_id_card_stats()` 即可重建。
- **新增字段不需要**：可执行 `ALTER TABLE fj_id_card DROP COLUMN updated_at, DROP COLUMN created_at;`（确认无业务依赖后再做）。
