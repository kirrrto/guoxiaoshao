const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesFromBase64(text) {
  const values = new Uint8Array(Math.floor(text.length * 3 / 4));
  let pos=0, bits=0, value=0;
  for (let i=0; i<text.length && text[i]!=='='; i++) {
    value=(value<<6)|alphabet.indexOf(text[i]);
    bits+=6;
    if(bits>=8) { bits-=8; values[pos++]=(value>>bits)&255; }
  }
  return values.subarray(0,pos);
}
function utf8(bytes) {
  let result='';
  for(let i=0; i<bytes.length;) {
    let c=bytes[i++];
    if(c>=240) c=((c&7)<<18)|((bytes[i++]&63)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63);
    else if(c>=224) c=((c&15)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63);
    else if(c>=192) c=((c&31)<<6)|(bytes[i++]&63);
    result+=String.fromCodePoint(c);
  }
  return result;
}
module.exports = function unpack([size,encoded]) {
  const source=bytesFromBase64(encoded), out=new Uint8Array(size);
  let from=0,to=0;
  while(from<source.length) {
    const tag=source[from++];
    if(tag<128) {
      const count=tag+1;
      out.set(source.subarray(from,from+count),to);from+=count;to+=count;
    } else {
      const count=(tag&127)+3, offset=source[from++]|(source[from++]<<8);
      if(!offset || offset>to || to+count>size) throw Error('Invalid English copy');
      for(let i=0;i<count;i++) {out[to]=out[to-offset];to++;}
    }
  }
  if(to!==size) throw Error('Incomplete English copy');
  return JSON.parse(utf8(out));
};
