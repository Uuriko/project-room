import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=`http://127.0.0.1:${process.env.DOCS_FIXTURE_PORT||43874}`;const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
const a=await browser.newPage(), b=await browser.newPage();
try {
 await Promise.all([a.goto(`${base}/?doc=runbook`),b.goto(`${base}/?doc=runbook`)]);
 await Promise.all([a.getByRole('button',{name:'Edit Markdown'}).click(),b.getByRole('button',{name:'Edit Markdown'}).click()]);
 await a.getByLabel('Markdown draft').fill('# Recovery test\n\nunsaved unique text');
 await b.getByLabel('Markdown draft').fill('# Recovery test\n\nconcurrent writer');
 await b.getByRole('button',{name:'Save changes'}).click();await b.getByText('Saved.',{exact:true}).waitFor();
 await a.reload();await a.getByText(/Recovered an unsaved draft/).waitFor();assert.match(await a.getByLabel('Markdown draft').inputValue(),/unsaved unique text/);
 await a.getByRole('button',{name:'Save changes'}).click();await a.getByText(/This document changed/).waitFor();assert.match(await a.locator('#conflict').innerText(),/concurrent writer/);
 await a.getByRole('button',{name:/Use revision .* as base/}).click();await a.getByLabel('Markdown draft').fill('# Recovery test\n\nrevised after rebase');await a.reload();
 assert.match(await a.getByLabel('Markdown draft').inputValue(),/revised after rebase/);await a.getByRole('button',{name:'Save changes'}).click();await a.getByText('Saved.',{exact:true}).waitFor();await a.reload();assert.equal(await a.getByText(/Recovered an unsaved draft/).count(),0);
 console.log('PASS: reload recovery, concurrent edit conflict, rebase plus further typing, save and draft removal');
} finally {await browser.close()}
