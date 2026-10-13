import schemastery from '@deepseek-ai/schemastery'

export const Config = schemastery.object({
  // 服务间认证配置
  auth: schemastery.object({
    // 服务间 token（简化认证）
    serviceToken: schemastery.string().description('服务间调用的认证 token').default(''),
    // 终端用户令牌的请求头名（大小写不敏感）；同时兼容同名 Cookie。
    // 调用方按会话传入，插件按会话暂存，供工具插件读取（用于服务端到服务端透传调用方身份）。
    userTokenHeader: schemastery.string().description('终端用户令牌的请求头名').default('x-user-token'),
    // TODO: 后续支持 mTLS
  }).description('服务间认证配置'),

  // HTTP 路由配置
  http: schemastery.object({
    // 对外 API 的路由前缀（不要以 / 结尾）
    basePath: schemastery.string().description('对外 API 路由前缀').default('/v1'),
  }).description('HTTP 路由配置'),

  // 并发控制
  concurrency: schemastery.object({
    // 全局并发 turn 上限
    maxGlobalTurns: schemastery.number().min(1).default(10).description('全局并发 turn 数上限'),
    // 单会话是否串行（同一会话的 turn 排队执行）
    serialPerSession: schemastery.boolean().default(true).description('单会话 turn 串行执行'),
  }).description('并发控制配置'),

  // SSE 连接配置
  sse: schemastery.object({
    // 全局 SSE 连接数上限
    maxConnections: schemastery.number().min(1).default(100).description('全局 SSE 连接数上限'),
    // 每用户 SSE 连接数上限
    maxConnectionsPerUser: schemastery.number().min(1).default(5).description('每用户 SSE 连接数上限'),
    // 单连接待发送缓冲区上限（字节）；超出说明客户端消费过慢，主动断开避免内存无界增长
    maxQueueSize: schemastery.number().min(4096).default(1024 * 1024).description('单连接待发送缓冲区上限（字节）'),
  }).description('SSE 连接配置'),

  // 请求限制
  request: schemastery.object({
    // 请求体大小上限（字节）
    maxBodySize: schemastery.number().min(1024).default(1024 * 1024).description('请求体大小上限（字节）'),
  }).description('请求限制配置'),

  // 会话管理配置
  sessions: schemastery.object({
    // 单个 principal+agentId 组合最多创建的会话数
    maxPerIdentity: schemastery.number().default(20).description('单个 principal+agentId 组合最多创建的会话数'),
  }).description('会话管理配置'),

  // 工具收敛配置
  tools: schemastery.object({
    // agent setup 阶段允许的工具名白名单；空数组表示不做收敛（放开全部）
    allowedTools: schemastery.array(schemastery.string()).description('工具白名单，空数组表示不收敛').default([]),
  }).description('工具收敛配置'),

  // 交付物配置
  deliveries: schemastery.object({
    // 需要在执行后拦截并落盘为会话交付物的工具名（结果约定为 JSON 文本
    // `{ok,file_name,file_base64}`）；空数组表示关闭该能力
    fileTools: schemastery.array(schemastery.string()).description('产出文件的工具名，空数组表示关闭').default([]),
  }).description('交付物配置'),

  // 写作类智能体配置（document_type 注入）
  writing: schemastery.object({
    // 允许接收 document_type 的 agent ID；空数组表示不限制
    agents: schemastery.array(schemastery.string()).description('允许接收 document_type 的 agent ID，空数组表示不限制').default([]),
    // document_type 白名单；空数组表示关闭该能力
    documentTypes: schemastery.array(schemastery.string()).description('document_type 白名单，空数组表示关闭').default([]),
  }).description('写作类智能体配置'),

  // 智能体预设映射（URL agent ID -> preset name）
  agentPresets: schemastery.dict(schemastery.string()).description('智能体 ID 到 preset 名称的映射').default({}),

  // 审计日志配置
  audit: schemastery.object({
    enabled: schemastery.boolean().default(true).description('是否启用审计日志'),
  }).description('审计日志配置'),

  // 观测性配置
  observability: schemastery.object({
    // 是否把 ctx.logger 输出到终端
    // （dsh 0.1.3 默认只有内存 buffer，无终端 sink，见 lib/log-export.js）
    consoleExporter: schemastery.boolean().default(true).description('是否安装终端日志 exporter'),
    // 0=error 1=info 2=warn 3=debug，输出到该级别为止
    level: schemastery.number().min(0).max(3).default(3).description('终端日志级别上限'),
    colors: schemastery.boolean().default(true).description('终端日志是否着色'),
  }).description('观测性配置'),
})
