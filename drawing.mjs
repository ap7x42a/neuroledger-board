import {normalizeEffects,normalizeEffectRef,EFFECT_PRESETS} from './canvas-effects.mjs';
// Pure local drawing primitives. Import from a script you control; only toPlan() data is sent.
const integer=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
const color=c=>{if(typeof c!=='string'||!/^#[0-9a-f]{6}$/.test(c))throw new Error('Use lowercase #rrggbb colors.');return 0x1000000|parseInt(c.slice(1),16);};
const hex=n=>'#'+(n&0xffffff).toString(16).padStart(6,'0');
// Three by five uppercase glyphs. Unknown glyphs are refused instead of silently omitted.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-:!?/';
const glyphs=[
 '010101111101101','110101110101110','011100100100011','110101101101110','111100110100111','111100110100100',
 '011100101101011','101101111101101','111010010010111','001001001101010','101101110101101','100100100100111',
 '101111111101101','101111111111101','010101101101010','110101110100100','010101101111011','110101110101101',
 '011100010001110','111010010010010','101101101101111','101101101101010','101101111111101','101101010101101',
 '101101010010010','111001010100111','111101101101111','010110010010111','110001010100111','110001010001110',
 '101101111001001','111100110001110','011100111101111','111001010010010','111101111101111','111101111001110',
 '000000000000000','000000000000010','000000111000000','000010000010000','010010010000010','110001010000010','001001010100100'
];
const FONT=Object.fromEntries([...alphabet].map((c,i)=>[c,glyphs[i]]));
FONT._='000000000000111';

export class Drawing {
  #pixels;
  #effects={};
  #names=[];
  #indices;
  #phases;
  #steps;
  constructor(width,height,{x=0,y=0}={}) {
    if(!integer(width,1,2048)||!integer(height,1,2048)||!integer(x,0,2048-width)||!integer(y,0,2048-height))throw new Error('Drawing bounds must fit within 2048 by 2048.');
    this.width=width;this.height=height;this.x=x;this.y=y;this.#pixels=new Uint32Array(width*height);
  }
  defineEffect(name,definition) {
    const normalized=normalizeEffects({[name]:typeof definition==='string'?EFFECT_PRESETS[definition]:definition});
    if(Object.hasOwn(this.#effects,name)&&JSON.stringify(this.#effects[name])!==JSON.stringify(normalized[name]))throw new Error('Drawing effects are immutable; use a new name.');
    this.#effects=normalizeEffects({...this.#effects,...normalized});if(!this.#names.includes(name))this.#names.push(name);return this;
  }
  #brush(c) {
    if(typeof c==='string')return {n:color(c)};
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['color','effect','phase','step'].includes(k)))throw new Error('Use a color or {color,effect,phase?,step?} brush.');
    const {color:fallback,...input}=c,ref=normalizeEffectRef(input,this.#effects);return {n:color(fallback),ref,id:this.#names.indexOf(ref.effect)+1};
  }
  #put(x,y,brush,offset=0) {
    const index=y*this.width+x;this.#pixels[index]=brush.n;
    if(brush.ref){
      if(!this.#indices){const size=this.width*this.height;this.#indices=new Uint8Array(size);this.#phases=new Uint8Array(size);this.#steps=new Uint8Array(size);}
      this.#indices[index]=brush.id;this.#phases[index]=(brush.ref.phase+offset*brush.ref.step)%256;this.#steps[index]=brush.ref.step;
    }else if(this.#indices)this.#indices[index]=0;
  }
  #box(x,y,w=1,h=1) {
    if(!integer(w,1,this.width)||!integer(h,1,this.height)||!integer(x,0,this.width-w)||!integer(y,0,this.height-h))throw new Error('Drawing coordinates are out of bounds.');
  }
  pixel(x,y,c) {this.#box(x,y);this.#put(x,y,this.#brush(c));return this;}
  rect(x,y,width,height,c) {
    this.#box(x,y,width,height);const brush=this.#brush(c);
    for(let row=y;row<y+height;row++)for(let col=x;col<x+width;col++)this.#put(col,row,brush,(row-y)*width+col-x);
    return this;
  }
  line(x0,y0,x1,y1,c) {
    this.#box(x0,y0);this.#box(x1,y1);const brush=this.#brush(c),dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let error=dx+dy,offset=0;
    for(;;){this.#put(x0,y0,brush,offset++);if(x0===x1&&y0===y1)break;const e=2*error;if(e>=dy){error+=dy;x0+=sx;}if(e<=dx){error+=dx;y0+=sy;}}
    return this;
  }
  ellipse(x,y,width,height,c) {
    this.#box(x,y,width,height);const brush=this.#brush(c),rx=width/2,ry=height/2;
    for(let yy=0;yy<height;yy++)for(let xx=0;xx<width;xx++)if(((xx+.5-rx)/rx)**2+((yy+.5-ry)/ry)**2<=1)this.#put(x+xx,y+yy,brush,yy*width+xx);
    return this;
  }
  text(x,y,value,c,{scale=1}={}) {
    if(typeof value!=='string'||!value.length||value.length>128||!integer(scale,1,64))throw new Error('Text needs 1–128 supported characters and an integer scale.');
    const chars=[...value.toUpperCase()];if(chars.some(ch=>!Object.hasOwn(FONT,ch)))throw new Error('Text supports A–Z, 0–9, space and .-:!?/');
    this.#box(x,y,(chars.length*4-1)*scale,5*scale);this.#brush(c);
    chars.forEach((ch,i)=>{for(let p=0;p<15;p++)if(FONT[ch][p]==='1')this.rect(x+(i*4+p%3)*scale,y+Math.floor(p/3)*scale,scale,scale,c);});return this;
  }
  blit(x,y,rows,palette) {
    if(!Array.isArray(rows)||!rows.length||!palette||typeof palette!=='object'||Array.isArray(palette))throw new Error('Blit needs equal-width string rows and a color palette.');
    const symbols=[];
    for(const row of rows){
      if(typeof row!=='string')throw new Error('Blit needs equal-width string rows and a color palette.');
      symbols.push([...row]);
    }
    const width=symbols[0].length;
    if(!width||symbols.some(row=>row.length!==width))throw new Error('Blit needs equal-width string rows and a color palette.');
    this.#box(x,y,width,symbols.length);
    for(const row of symbols)for(const ch of row){if(ch==='.')continue;if(!Object.hasOwn(palette,ch))throw new Error('Missing palette color.');this.#brush(palette[ch]);}
    symbols.forEach((row,yy)=>{row.forEach((ch,xx)=>{if(ch!=='.')this.pixel(x+xx,y+yy,palette[ch]);});});return this;
  }
  toPlan() {
    const runs=[],used=new Set();
    for(let y=0;y<this.height;y++)for(let x=0;x<this.width;){
      const n=this.#pixels[y*this.width+x];if(!n){x++;continue;}
      const at=y*this.width+x,id=this.#indices?.[at]??0,ref=id?{effect:this.#names[id-1],phase:this.#phases[at],step:this.#steps[at]}:null;let end=x+1;
      while(end<this.width&&this.#pixels[y*this.width+end]===n){
        const next=y*this.width+end,nextId=this.#indices?.[next]??0;
        if(ref?(nextId!==id||this.#steps[next]!==ref.step||this.#phases[next]!==(ref.phase+(end-x)*ref.step)%256):nextId)break;
        end++;
      }
      runs.push([x+this.x,y+this.y,end-x,hex(n),...(ref?[{...ref}]:[])]);if(ref)used.add(ref.effect);x=end;
    }
    return used.size?{version:2,runs,effects:normalizeEffects(Object.fromEntries([...used].map(name=>[name,this.#effects[name]])))}:{version:1,runs};
  }

  toSVG() {
    const rectangles=this.toPlan().runs.map(([x,y,width,c])=>`<rect x="${x-this.x}" y="${y-this.y}" width="${width}" height="1" fill="${c}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" shape-rendering="crispEdges"><rect width="${this.width}" height="${this.height}" fill="#080a0d"/>${rectangles}</svg>`;
  }
}
