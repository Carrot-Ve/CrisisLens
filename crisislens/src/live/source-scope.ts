/** Only extract an explicitly named event; do not guess entities from vague follow-ups. */
export function explicitEventSubject(request:string):string|null {
  const match=/(?:调查|核实|分析|关于|了解|查一下)\s*(.{2,30}?)事件/.exec(request);
  if(!match)return null;
  const subject=match[1]!.replace(/^(?:一下|有关|关于|一个|一起|这起|这个)/,'').replace(/\d{4}年(?:的)?/g,'').trim();
  if(subject.length<2 || /舆情|上述|这个|这起|该起|相关|测试|公共/.test(subject))return null;
  return subject;
}
export function sourceMatchesSubject(subject:string|null,page:{title:string;content:string}):boolean {
  return !subject || (page.title+' '+page.content).replace(/\s/g,'').includes(subject.replace(/\s/g,''));
}
