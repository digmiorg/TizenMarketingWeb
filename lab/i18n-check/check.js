/**
 * Fails when a message key is missing from a language, or named somewhere and
 * defined nowhere.
 *
 * Why this exists: brand.js `t()` returns the KEY ITSELF for anything it
 * cannot find, so a key added to `sv` and forgotten in `fi` does not throw and
 * does not fall back - it writes `off.title` across a Finnish screen, and the
 * first person to find out is the salon standing in front of it. This repo has
 * no lint or test job (only deploy and release workflows), so nothing else
 * would catch it.
 *
 * Not wired into CI. Run it by hand after touching texts:
 *
 *   node lab/i18n-check/check.js
 *
 * Exits 0 and prints a one-line summary when everything lines up.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const brand = require(path.join(root, 'src', 'js', 'brand.js'));
const MESSAGES = brand.MESSAGES;

const languages = Object.keys(MESSAGES);
const problems = [];

// 1. Every language carries exactly the key set `sv` does. Both directions:
//    a key missing from one language renders as its own name, and a key only
//    present in one language is a translation nobody will ever see.
const reference = Object.keys(MESSAGES.sv).sort();

languages.forEach(function (lang) {
  const keys = Object.keys(MESSAGES[lang]).sort();

  reference.forEach(function (key) {
    if (keys.indexOf(key) === -1) {
      problems.push(lang + ' is missing ' + key);
    }
  });

  keys.forEach(function (key) {
    if (reference.indexOf(key) === -1) {
      problems.push(lang + ' has ' + key + ', which sv does not');
    }
  });
});

// 2. Every language names the same `{placeholders}` as `sv`.
//
//    fillText() clears `textContent` before it writes, which removes the
//    `[data-i18n-slot]` children it had just collected. A placeholder missing
//    from the text is therefore never put back: drop `{phone}` from one
//    language's `reg.help` and that language's screen loses the `tel:` link
//    entirely, with no error. Measured in Chrome - the anchor count goes from
//    2 to 1. The switched-off face leans on that help line being the only
//    thing on the page that leads anywhere, so this is the check that keeps
//    the promise.
const placeholders = function (text) {
  const found = text.match(/\{(\w+)\}/g);
  return (found === null ? [] : found).sort();
};

reference.forEach(function (key) {
  const want = placeholders(MESSAGES.sv[key]).join(',');

  languages.forEach(function (lang) {
    if (!Object.prototype.hasOwnProperty.call(MESSAGES[lang], key)) {
      return;
    }

    const got = placeholders(MESSAGES[lang][key]).join(',');
    if (got !== want) {
      problems.push(
        lang + ' ' + key + ' has placeholders [' + got + '], sv has [' + want + ']'
      );
    }
  });
});

// 3. Every key the page asks for by `data-i18n` is defined.
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const attributeKeys = [];
const attributePattern = /data-i18n="([^"]+)"/g;
let match = attributePattern.exec(html);

while (match !== null) {
  attributeKeys.push(match[1]);
  match = attributePattern.exec(html);
}

attributeKeys.forEach(function (key) {
  if (reference.indexOf(key) === -1) {
    problems.push('index.html asks for ' + key + ', which is defined nowhere');
  }
});

// 4. Every key main.js names as a literal is defined. The prefixes are listed
//    rather than matched as "anything dotted", so an unrelated dotted string
//    such as a MIME type cannot be mistaken for a message key.
//
//    All three quote styles, and digits in the key: single quotes alone missed
//    `"off.title"` and `` `off.title` `` silently, and the character class
//    without 0-9 missed a key like `off.title2` - a check that skips what it
//    cannot parse is worse than no check, because it reports ok.
//
//    `eyebrow` is not in the list: it has no dot, so no pattern of this shape
//    can match it, and main.js never names it.
//
//    Known limitation, deliberately this way round: a key named only in a
//    COMMENT counts as a use. An earlier version required an argument
//    position to exclude comments, which did not work - it excluded the one
//    comment that had tripped the run, not comments - and it silently stopped
//    seeing `['off.a', 'off.b']` (first element), `const k = 'off.a'` and
//    `return 'off.a'`. Telling comments from code needs a tokenizer, not a
//    regex: `//` occurs inside the URLs in main.js.
//
//    So the trade is made in the loud direction. Delete a key and leave a
//    comment naming it and this run goes red, which is a sentence that needed
//    updating anyway. The alternative failed quietly, and a check that skips
//    what it cannot parse is worse than no check, because it reports ok.
const main = fs.readFileSync(path.join(root, 'src', 'js', 'main.js'), 'utf8');
const literalPattern =
  /['"`]((?:reg|off|loader|loading|offline|toast|info)\.[A-Za-z0-9_.]+)['"`]/g;
const literalKeys = [];
match = literalPattern.exec(main);

while (match !== null) {
  literalKeys.push(match[1]);
  match = literalPattern.exec(main);
}

literalKeys.forEach(function (key) {
  if (reference.indexOf(key) === -1) {
    problems.push('main.js names ' + key + ', which is defined nowhere');
  }
});

if (problems.length > 0) {
  problems.forEach(function (problem) {
    process.stderr.write('MISSING  ' + problem + '\n');
  });
  process.exit(1);
}

process.stdout.write(
  'ok: ' +
    reference.length +
    ' keys x ' +
    languages.length +
    ' languages (' +
    languages.join(', ') +
    '), ' +
    attributeKeys.length +
    ' data-i18n uses, ' +
    literalKeys.length +
    ' literals in main.js\n'
);
