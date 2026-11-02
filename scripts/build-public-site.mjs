
import {mkdir,copyFile,readdir,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const output=resolve('.runtime/public-site');
await mkdir(output,{recursive:true});
const files=['index.html','index-en.html','help.html','help-tr.html','privacy.html','privacy-tr.html','terms.html','terms-tr.html','styles.css','staticwebapp.config.json','open.html','archivo-latin.woff2','archivo-latin-ext.woff2','dealio-icon.webp','alert-en.webp','alert-tr.webp','alerts-panel-en.webp','alerts-panel-tr.webp','index-de.html','help-de.html','privacy-de.html','terms-de.html','index-fr.html','help-fr.html','privacy-fr.html','terms-fr.html','alert-de.webp','alert-fr.webp','alerts-panel-de.webp','alerts-panel-fr.webp'];
for(const file of await readdir(output))if(!files.includes(file))throw new Error('Unexpected public output: '+file);
for(const file of files)await copyFile(join('docs',file),join(output,file));
console.log('Public site built from '+files.length+' approved files; internal docs excluded.');
