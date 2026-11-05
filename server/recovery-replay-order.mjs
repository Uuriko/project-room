// ECMAScript Object.values: canonical array-index keys first in numeric order,
// then other string keys in insertion order. 2**32-1 is not an array index.
export function recoveryReplayOrderKey(key, ordinal) {
 if(typeof key!=='string'||!Number.isSafeInteger(ordinal)||ordinal<0)throw Error('Invalid replay map order');
 const number=Number(key);
 return Number.isInteger(number)&&number>=0&&number<4294967295&&String(number)===key
  ?'0:'+String(number).padStart(10,'0'):'1:'+String(ordinal).padStart(16,'0');
}
