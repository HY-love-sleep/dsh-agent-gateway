import util from 'node:util'

/**
 * 终端日志导出器
 *
 * 背景：cordis 的 `ctx.logger` 默认只挂一个**内存环形缓冲** exporter
 * （`LoggerService` 构造时注册，只 push 进 buffer，不落终端）。dsh 0.1.3-alpha.2
 * 里既没有 CLI 侧的 console exporter，dsh-base 也没有日志插件——唯一注册
 * 真实 exporter 的是 `dsh-session-telemetry-otel`（走 OTLP，不是终端）。
 * 因此在这个 profile 里，所有 `ctx.logger.*` 调用都是「只进 buffer、不可见」。
 *
 * 这里用框架自己的 exporter seam（`ctx.logger.exporter()`）补一个终端 sink，
 * 让 dsh 的观测能力真正可用。exporter 通过 `ctx.effect` 绑定到插件 fiber，
 * 插件卸载时自动摘除。
 *
 * 消亡条件：上游提供官方终端日志插件后，删掉本文件，改为在 profile 中加载该插件。
 */

// cordis 的级别编号：0=error 1=info 2=warn 3=debug，
// 过滤条件是 `threshold < level → 跳过`，所以 threshold 越大输出越全。
const LEVEL_LABEL = ['ERROR', 'INFO ', 'WARN ', 'DEBUG']
const LEVEL_COLOR = [31, 36, 33, 90]

/**
 * 安装终端 exporter
 * @param {object} ctx - 插件 context
 * @param {number} level - 0..3，输出到该级别为止（默认 3，全开）
 * @param {boolean} colors - 是否着色
 * @returns {() => void} disposer
 */
export function installConsoleExporter(ctx, level = 3, colors = true) {
  return ctx.logger.exporter({
    colors: colors ? 3 : 0,
    levels: { default: level },
    export(message) {
      const line = `${formatLevel(message.level, colors)} [${message.name}] ${util.format(...message.args)}`
      // error/warn 走 stderr，其余走 stdout，便于分开重定向
      if (message.level === 0 || message.level === 2) {
        process.stderr.write(line + '\n')
      } else {
        process.stdout.write(line + '\n')
      }
    },
  })
}

function formatLevel(level, colors) {
  const label = LEVEL_LABEL[level] ?? 'LOG  '
  if (!colors) {
    return label
  }
  return `[${LEVEL_COLOR[level] ?? 0}m${label}[0m`
}
