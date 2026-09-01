#!/usr/bin/env bash
#
# start-services.sh — 一键管理 测试库(5173) 与 生产库(5174) 两个服务
#
# 端口与环境映射:
#   5173 = 测试环境 -> infocard_test 测试库 (加载 .env)
#   5174 = 生产环境 -> infocard 正式库   (加载 .env.prod, 需 --prod)
#
# 用法:
#   scripts/start-services.sh start          启动两个服务（已在运行的自动跳过）
#   scripts/start-services.sh stop           停止两个服务
#   scripts/start-services.sh restart        重启两个服务
#   scripts/start-services.sh status         查看两个服务运行状态
#   scripts/start-services.sh start:test     仅启动测试服务
#   scripts/start-services.sh start:prod     仅启动生产服务
#   scripts/start-services.sh stop:test      仅停止测试服务
#   scripts/start-services.sh stop:prod      仅停止生产服务
#
# 说明:
#   - 服务以后台守护方式运行（nohup），日志落盘 logs/server-<port>.log，
#     PID 记录在 logs/server-<port>.pid，与终端完全解耦。
#   - 生产库为千万级正式数据，操作前请确认目标正确。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$BASE_DIR/logs"
mkdir -p "$LOG_DIR"

# ---- 服务定义 ----
# 测试服务：5173，连接测试库
TEST_PORT="5173"
TEST_LABEL="测试库(infocard_test)"
TEST_CMD="env PORT=5173 node server/index.js"
# 生产服务：5174，连接正式库（--prod 加载 .env.prod）
PROD_PORT="5174"
PROD_LABEL="生产库(infocard)"
PROD_CMD="env PORT=5174 node server/index.js --prod"

# ---- 工具函数 ----
is_running_by_pid() { # $1=pid 文件
  local pidfile="$1"
  [ -f "$pidfile" ] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

port_in_use() { # $1=port
  lsof -iTCP:"$1" -sTCP:LISTEN -P 2>/dev/null | grep -q .
}

start_one() { # $1=port $2=label $3=cmd
  local port="$1" label="$2" cmd="$3"
  local logfile="$LOG_DIR/server-$port.log" pidfile="$LOG_DIR/server-$port.pid"

  if is_running_by_pid "$pidfile"; then
    echo "▶ $label 已在运行 (PID $(cat "$pidfile")) — 跳过"
    return 0
  fi
  if port_in_use "$port"; then
    echo "⚠ $label 端口 $port 被其他进程占用，未启动（lsof -iTCP:$port -sTCP:LISTEN -P 查看占用者）"
    return 1
  fi

  echo "⏳ 启动 $label -> http://localhost:$port (日志: $logfile)"
  ( cd "$BASE_DIR" && nohup $cmd >> "$logfile" 2>&1 & )

  # 等待端口就绪（最长 10s），就绪后用「实际监听端口的进程」记录 PID
  # （nohup 包装进程与实际 node 进程 PID 可能不同，必须记真实 PID 才能准确 stop）
  local realpid=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if port_in_use "$port"; then
      realpid="$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -1)"
      break
    fi
    sleep 1
  done

  if [ -n "$realpid" ]; then
    echo "$realpid" > "$pidfile"
    echo "✅ $label 已启动: http://localhost:$port (PID $realpid)"
    return 0
  fi
  echo "❌ $label 启动超时，请查看日志 $logfile"
  return 1
}

stop_one() { # $1=port $2=label
  local port="$1" label="$2"
  local pidfile="$LOG_DIR/server-$port.pid" pid=""

  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "⏳ 停止 $label (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "⚠ $label 未在 10s 内退出，强制结束"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    echo "✅ $label 已停止"
  elif port_in_use "$port"; then
    local occupier
    occupier="$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -1)"
    if [ -n "$occupier" ] && ps -p "$occupier" -o command= 2>/dev/null | grep -q "server/index.js"; then
      # 无 PID 记录但端口被本项目服务占用：终止该进程（兜底）
      echo "⏳ $label 无 PID 记录但端口 $port 被本项目进程 $occupier 占用，正在终止..."
      kill -TERM "$occupier" 2>/dev/null || true
      sleep 2
      kill -0 "$occupier" 2>/dev/null && kill -KILL "$occupier" 2>/dev/null || true
      echo "✅ $label 已停止(兜底终止 $occupier)"
    else
      echo "⚠ $label 无 PID 记录且端口 $port 被其他进程 $occupier 占用（非本项目，未自动处理）"
    fi
  else
    echo "ℹ $label 未在运行"
  fi

  # 兜底：若 kill 掉了错误的中间进程、端口仍被本项目进程占用，再补杀一次
  if port_in_use "$port"; then
    local occupier2
    occupier2="$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -1)"
    if [ -n "$occupier2" ] && ps -p "$occupier2" -o command= 2>/dev/null | grep -q "server/index.js"; then
      echo "⚠ $label 端口 $port 仍被本项目进程 $occupier2 占用，强制终止..."
      kill -KILL "$occupier2" 2>/dev/null || true
      echo "✅ $label 已停止(补杀 $occupier2)"
    fi
  fi
  rm -f "$pidfile"
}

status_one() { # $1=port $2=label
  local port="$1" label="$2"
  local pidfile="$LOG_DIR/server-$port.pid" pid=""

  if is_running_by_pid "$pidfile"; then
    pid="$(cat "$pidfile")"
    echo "● $label  端口 $port  运行中  PID $pid  启动于 $(ps -o lstart= -p "$pid" 2>/dev/null)"
  elif port_in_use "$port"; then
    local occupier
    occupier="$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -1)"
    echo "○ $label  端口 $port  运行中(非本脚本管理) PID $occupier"
  else
    echo "○ $label  端口 $port  未运行"
  fi
}

usage() {
  sed -n '2,20p' "$0"
  exit 0
}

# ---- 主流程 ----
ACTION="${1:-start}"

case "$ACTION" in
  start)
    echo "== 启动服务 =="
    start_one "$TEST_PORT" "$TEST_LABEL" "$TEST_CMD"
    start_one "$PROD_PORT" "$PROD_LABEL" "$PROD_CMD"
    ;;
  stop)
    echo "== 停止服务 =="
    stop_one "$TEST_PORT" "$TEST_LABEL"
    stop_one "$PROD_PORT" "$PROD_LABEL"
    ;;
  restart)
    echo "== 重启服务 =="
    stop_one "$TEST_PORT" "$TEST_LABEL"
    stop_one "$PROD_PORT" "$PROD_LABEL"
    start_one "$TEST_PORT" "$TEST_LABEL" "$TEST_CMD"
    start_one "$PROD_PORT" "$PROD_LABEL" "$PROD_CMD"
    ;;
  status)
    echo "== 服务状态 =="
    status_one "$TEST_PORT" "$TEST_LABEL"
    status_one "$PROD_PORT" "$PROD_LABEL"
    echo "（●=本脚本管理运行中 ○=未运行/他方占用）"
    ;;
  start:test) start_one "$TEST_PORT" "$TEST_LABEL" "$TEST_CMD" ;;
  start:prod) start_one "$PROD_PORT" "$PROD_LABEL" "$PROD_CMD" ;;
  stop:test)  stop_one  "$TEST_PORT" "$TEST_LABEL" ;;
  stop:prod)  stop_one  "$PROD_PORT" "$PROD_LABEL" ;;
  *)
    echo "未知命令: $ACTION"
    usage
    ;;
esac
