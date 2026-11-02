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
  constructor(width,height,{x=0,y=0}={}) {
    if(!integer(width,1,2048)||!integer(height,1,2048)||!integer(x,0,2048-width)||!integer(y,0,2048-height))throw new Error('Drawing bounds must fit within 2048 by 2048.');
    this.width=width;this.height=height;this.x=x;this.y=y;this.#pixels=new Uint32Array(width*height);
  }
  #box(x,y,w=1,h=1) {
    if(!integer(w,1,this.width)||!integer(h,1,this.height)||!integer(x,0,this.width-w)||!integer(y,0,this.height-h))throw new Error('Drawing coordinates are out of bounds.');
  }
  pixel(x,y,c) {this.#box(x,y);this.#pixels[y*this.width+x]=color(c);return this;}
  rect(x,y,width,height,c) {
    this.#box(x,y,width,height);const n=color(c);
    for(let row=y;row<y+height;row++)this.#pixels.fill(n,row*this.width+x,row*this.width+x+width);
    return this;
  }
  line(x0,y0,x1,y1,c) {
    this.#box(x0,y0);this.#box(x1,y1);const n=color(c),dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let error=dx+dy;
    for(;;){this.#pixels[y0*this.width+x0]=n;if(x0===x1&&y0===y1)break;const e=2*error;if(e>=dy){error+=dy;x0+=sx;}if(e<=dx){error+=dx;y0+=sy;}}
    return this;
  }
  ellipse(x,y,width,height,c) {
    this.#box(x,y,width,height);const n=color(c),rx=width/2,ry=height/2;
    for(let yy=0;yy<height;yy++)for(let xx=0;xx<width;xx++)if(((xx+.5-rx)/rx)**2+((yy+.5-ry)/ry)**2<=1)this.#pixels[(y+yy)*this.width+x+xx]=n;
    return this;
  }
  text(x,y,value,c,{scale=1}={}) {
    if(typeof value!=='string'||!value.length||value.length>128||!integer(scale,1,64))throw new Error('Text needs 1–128 supported characters and an integer scale.');
    const chars=[...value.toUpperCase()];if(chars.some(ch=>!Object.hasOwn(FONT,ch)))throw new Error('Text supports A–Z, 0–9, space and .-:!?/');
    this.#box(x,y,(chars.length*4-1)*scale,5*scale);color(c);
    chars.forEach((ch,i)=>{for(let p=0;p<15;p++)if(FONT[ch][p]==='1')this.rect(x+(i*4+p%3)*scale,y+Math.floor(p/3)*scale,scale,scale,c);});return this;
  }
  blit(x,y,rows,palette) {
    if(!Array.isArray(rows)||!rows.length||typeof rows[0]!=='string'||!rows[0].length||rows.some(r=>typeof r!=='string'||r.length!==rows[0].length)||!palette||typeof palette!=='object'||Array.isArray(palette))throw new Error('Blit needs equal-width string rows and a color palette.');
    this.#box(x,y,rows[0].length,rows.length);
    for(const row of rows)for(const ch of row){if(ch==='.')continue;if(!Object.hasOwn(palette,ch))throw new Error('Missing palette color.');color(palette[ch]);}
    rows.forEach((row,yy)=>{[...row].forEach((ch,xx)=>{if(ch!=='.')this.pixel(x+xx,y+yy,palette[ch]);});});return this;
  }
  toPlan() {
    const runs=[];
    for(let y=0;y<this.height;y++)for(let x=0;x<this.width;){const n=this.#pixels[y*this.width+x];if(!n){x++;continue;}let end=x+1;while(end<this.width&&this.#pixels[y*this.width+end]===n)end++;runs.push([x+this.x,y+this.y,end-x,hex(n)]);x=end;}
    return {version:1,runs};
  }
  toSVG() {
    const rectangles=this.toPlan().runs.map(([x,y,width,c])=>`<rect x="${x-this.x}" y="${y-this.y}" width="${width}" height="1" fill="${c}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" shape-rendering="crispEdges"><rect width="${this.width}" height="${this.height}" fill="#080a0d"/>${rectangles}</svg>`;
  }
}
