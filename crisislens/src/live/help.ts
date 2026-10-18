/** Product help is deterministic: it describes implemented tools, not event facts. */
export function capabilityReply(message:string):string|null {
  const question=message.replace(/[\s，。！？?！、]/g,'');
  if(!/^(?:那|你|你们|这里|这个助手|到底|所以|请问)*(?:(?:能|可以|能够)(?:查|调查|搜索|做)(?:什么|哪些)|有什么功能|功能有哪些|怎么使用)(?:啊|呀|呢|吗)?$/.test(question))return null;
  return '我可以联网搜索公开新闻、官方通报和企业公告，读取公开网页，并基于原文整理事件时间线、比较不同来源、列出冲突和待核实项。你也可以直接提供网页链接。\n\n例如：“调查某事件，先找官方通报并区分已知与未知”，或“比较这两篇报道的说法”。\n\n搜索或网页读取可能受限，受限不代表事件不存在；我不能访问登录后的私密内容，也不能把单篇报道当作完整核验结论。';
}
