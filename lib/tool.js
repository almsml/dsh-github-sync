/**
 * 工具定义的极简构造器。
 *
 * 不 import '@deepseek-ai/dsh-tools'：插件可能以 junction/链接方式安装，
 * 裸包名解析依赖 DSH 宿主内部映射，动态 import 失败会让整个工具静默消失。
 * 这里直接产出注册表需要的形状（JSON Schema + output.render），
 * 参数由 execute 自己兜底，避免多一层运行时依赖。
 */

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, {type:string, description?:string, enum?:string[]}>} options.parameters
 *        简单参数表：{ 参数名: { type, description?, enum? } }，全部可选。
 * @param {(args:Record<string, unknown>, exec:any)=>Promise<object>} options.execute
 * @param {(value:object)=>string} options.text 把返回值渲染成模型可读文本
 */
export function simpleTool(options) {
  const properties = {}
  for (const [key, spec] of Object.entries(options.parameters || {})) {
    const property = { type: spec.type || 'string' }
    if (spec.description) property.description = spec.description
    if (Array.isArray(spec.enum) && spec.enum.length > 0) property.enum = spec.enum
    properties[key] = property
  }
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties,
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: options.text(value) }],
    },
    execute: options.execute,
  }
}
