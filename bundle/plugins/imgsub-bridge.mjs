// imgsub-bridge: makes subagent image prompts durable.
//
// The shipped client hard-rejects image content for continuable subagent
// addresses, and the dynamic-plugin sandbox boundary mangles binary
// arguments, so the dynamic imgsub client patch routes raw image blocks
// through api.subagents.prompt (base64 is JSON-safe). This real host plugin
// wraps `subagents.followup` — the same service the RPC routes through — and
// replaces raw-data image blocks with attachment references (validateImage +
// saveImage) before the message reaches the child's inbox. The child's
// vision model then reads the image through the ordinary attachment path.
import { Buffer } from 'node:buffer'

export default {
  inject: ['subagents', 'attachments'],
  apply(ctx) {
    const subagents = ctx.subagents
    if (typeof subagents.followup !== 'function' || subagents.followup.__imgsubBridge === true) return
    const original = subagents.followup.bind(subagents)
    const bridged = async (parent, childId, content, options) => {
      const blocks = []
      for (const part of content) {
        if (part !== null && typeof part === 'object' && part.type === 'image' && typeof part.data === 'string' && part.data.length > 0) {
          const mediaType = typeof part.mediaType === 'string' ? part.mediaType : 'image/png'
          const name = typeof part.name === 'string' && part.name.length > 0 ? part.name : undefined
          const bytes = new Uint8Array(Buffer.from(part.data, 'base64'))
          const input = { data: bytes, mediaType, ...(name === undefined ? {} : { name }) }
          try {
            await ctx.attachments.validateImage(input)
            const ref = await ctx.attachments.saveImage(input)
            blocks.push({ type: 'image', attachment: ref })
          } catch (error) {
            throw new Error('图片校验失败：' + (error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)))
          }
        } else if (part !== null && typeof part === 'object') {
          blocks.push(part)
        }
      }
      return original(parent, childId, blocks, options)
    }
    bridged.__imgsubBridge = true
    subagents.followup = bridged
  },
}
