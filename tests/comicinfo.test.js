'use strict';
/**
 * Node unit tests for cdl-comicinfo.js (run: `node tests/comicinfo.test.js`).
 */
const C = require('../cdl-comicinfo.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }

const xml = C.buildComicInfoXml({
  series: 'Solo Leveling', number: '12', count: 179, title: '',
  summary: 'A & B <tag> "q"', genres: ['Action', 'Fantasy'], tags: 'webtoon',
  web: 'https://comix.to/title/x/1-chapter-12', pageCount: 30, language: 'en', manga: 'Yes'
});

check('starts with XML declaration', xml.indexOf('<?xml') === 0);
check('has ComicInfo root + close', /<ComicInfo[ >]/.test(xml) && /<\/ComicInfo>/.test(xml));
check('series element', xml.includes('<Series>Solo Leveling</Series>'));
check('number element', xml.includes('<Number>12</Number>'));
check('count element (number coerced)', xml.includes('<Count>179</Count>'));
check('genres array joined', xml.includes('<Genre>Action, Fantasy</Genre>'));
check('tags string kept', xml.includes('<Tags>webtoon</Tags>'));
check('summary XML-escaped', xml.includes('<Summary>A &amp; B &lt;tag&gt; &quot;q&quot;</Summary>'));
check('empty title omitted', !/<Title>/.test(xml));
check('web element', xml.includes('<Web>https://comix.to/title/x/1-chapter-12</Web>'));
check('pageCount element', xml.includes('<PageCount>30</PageCount>'));
check('language element', xml.includes('<LanguageISO>en</LanguageISO>'));
check('manga element', xml.includes('<Manga>Yes</Manga>'));

// Omission + escaping edge cases
const empty = C.buildComicInfoXml({});
check('empty fields → just root', /<ComicInfo[^>]*>\s*<\/ComicInfo>/.test(empty));
check('xmlEscape handles quotes/apos', C.xmlEscape('"\'') === '&quot;&apos;');
check('never throws on null', typeof C.buildComicInfoXml(null) === 'string');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
