// ES5 view helpers. Only rendered copy and picker labels pass through here.
function format(value,args) {
  var out = '';
  for (var i=0;i<value.length;i++) {
    if (value.charAt(i)==='{' && value.charAt(i+2)==='}') {
      // Native WXS arrays require a numeric index, including for slot 0.
      var slot=value.charCodeAt(i+1)-48;
      if (slot>=0 && slot<=9) {
        var part=args[slot];
        out+=part===undefined || part===null ? '' : part;
        i+=2;
        continue;
      }
    }
    out+=value.charAt(i);
  }
  return out;
}
function captures(value, rule) {
  var chunks=rule.literals;
  if (value.indexOf(chunks[0])!==0) return null;
  var start=chunks[0].length, args=[];
  for (var i=0;i<rule.slots.length;i++) {
    var suffix=chunks[i+1], last=i===rule.slots.length-1;
    var end=last ? value.length-suffix.length : value.indexOf(suffix,start);
    if (end<start || value.slice(end,end+suffix.length)!==suffix) return null;
    var captured=value.slice(start,end);
    if (args[rule.slots[i]]!==undefined && args[rule.slots[i]]!==captured) return null;
    args[rule.slots[i]]=captured;
    start=end+suffix.length;
  }
  return start===value.length ? args : null;
}
function lookup(I,value,depth,used) {
  if (!I || typeof value!=='string' || value==='') return value;
  var exact=I.words[value];
  if (typeof exact==='string') {
    if (used) used(value,exact);
    return exact;
  }
  if (depth>=3) return value;
  var ideograph=false;
  for (var h=0;h<value.length;h++) { var code=value.charCodeAt(h); if (code>=11904 && code<=40959) { ideograph=true; break; } }
  if (!ideograph) return value;
  for(var j=0;j<I.patterns.length;j++){
    var rule=I.patterns[j], matched=captures(value,rule);
    if(!matched) continue;
    for(var k=0;k<matched.length;k++) matched[k]=lookup(I,matched[k],depth+1,used);
    return format(rule.value,matched);
  }
  var separators=['\n',' · ',' / ','、','：','。','；'];
  var joins=['\n',' · ',' / ', ', ', ': ', ' ', ' '];
  for(var n=0;n<separators.length;n++){
    var units=value.split(separators[n]);
    if (units.length<2) continue;
    for(var u=0;u<units.length;u++) units[u]=lookup(I,units[u],depth+1,used);
    return units.join(joins[n]);
  }
  return value;
}
function text(I,value,used){return lookup(I,value,0,used);}
function msg(I,key,args) {
  var values=[];
  for (var j=0;j<args.length;j++) values[j]=text(I,args[j]);
  var template=I && I.words[key];
  var value=format(typeof template==='string' ? template : key,values);
  return I && typeof template!=='string' ? text(I,value) : value;
}
function options(I,items,key) {
  if (!I || !items) return items;
  var out=[];
  for(var i=0;i<items.length;i++) {
    if (!key) { out.push(text(I,items[i])); continue; }
    var row={}; row[key]=text(I,items[i][key]);out.push(row);
  }
  return out;
}
module.exports={t:text,text:text,m:msg,options:options};
