-- =============================================================================
-- 03  private.norm() against the shared normalisation fixture
--
-- GENERATED FILE - DO NOT EDIT.
--   source:      supabase/tests/fixtures/normalize.json
--   regenerate:  npx tsx scripts/gen-normalize-test.ts
--
-- The unit test of the TypeScript twin (apps/web/src/lib/normalize.ts) runs the same
-- cases. Every character outside printable ASCII is written as a U&'\XXXX' escape.
-- Algorithm: docs/contracts/schema.md, section 2.1.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;
-- U&'...' literals and literal backslashes need the standard string syntax.
set local standard_conforming_strings = on;

select plan(63);

select is(private.norm(null), null, 'norm(NULL) is NULL');
select is(
  (select p.provolatile::text || '/' || p.proisstrict::text || '/'
          || (exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))::text
   from pg_proc p where p.oid = 'private.norm(text)'::regprocedure),
  'i/true/true',
  'private.norm(text) is IMMUTABLE and STRICT with a pinned search_path');

select is(
  private.norm(''),
  '',
  'norm 01: empty string');
select is(
  private.norm('   '),
  '',
  'norm 02: only spaces');
select is(
  private.norm('MASJID AL-NOOR'),
  'masjid al-noor',
  'norm 03: ASCII is lower-cased');
select is(
  private.norm('Shule ya Msingi (Qur''an) - No. 2, Wete!'),
  'shule ya msingi (qur''an) - no. 2, wete!',
  'norm 04: ASCII punctuation and digits are kept');
select is(
  private.norm('Kijiji cha Ng''ambo'),
  'kijiji cha ng''ambo',
  'norm 05: Swahili apostrophe is kept');
select is(
  private.norm('TZ-PN-000123'),
  'tz-pn-000123',
  'norm 06: project code');
select is(
  private.norm('+255 712 345 678'),
  '+255 712 345 678',
  'norm 07: phone number with spaces');
select is(
  private.norm('  Msikiti   wa    Ijumaa  '),
  'msikiti wa ijumaa',
  'norm 08: runs of spaces collapse, both ends are trimmed');
select is(
  private.norm(U&'  \0645\064E\0633\0652\062C\0650\062F\064F   \0627\0644\0646\0651\064F\0648\0631 '),
  U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631',
  'norm 09: tashkeel is removed (schema.md example)');
select is(
  private.norm(U&'\064B\064C\064D'),
  '',
  'norm 10: only tanween gives the empty string');
select is(
  private.norm(U&'\0628\064B\0633\065F\0645'),
  U&'\0628\0633\0645',
  'norm 11: tashkeel range bounds U+064B and U+065F');
select is(
  private.norm(U&'\0631\062D\0645\0670\0646'),
  U&'\0631\062D\0645\0646',
  'norm 12: superscript alef U+0670 is removed');
select is(
  private.norm(U&'\0628\06D6\0633\06E1\0645\06ED'),
  U&'\0628\0633\0645',
  'norm 13: Quranic annotation marks U+06D6..U+06ED are removed');
select is(
  private.norm(U&'\0628\0653\0628\0654\0628\0655\0628\0656'),
  U&'\0628\0628\0628\0628',
  'norm 14: marks U+0653..U+0656 on a letter that does not compose');
select is(
  private.norm(U&'\0645\0640\0640\062D\0645\062F'),
  U&'\0645\062D\0645\062F',
  'norm 15: tatweel is removed');
select is(
  private.norm(U&'\0640\0640\0640'),
  '',
  'norm 16: only tatweel gives the empty string');
select is(
  private.norm(U&'\0645\0640 \0640\062D'),
  U&'\0645 \062D',
  'norm 17: tatweel on both sides of a space');
select is(
  private.norm(U&'\0631\0623\0633'),
  U&'\0631\0627\0633',
  'norm 18: alef with hamza above becomes alef');
select is(
  private.norm(U&'\0625\0633\0644\0627\0645'),
  U&'\0627\0633\0644\0627\0645',
  'norm 19: alef with hamza below becomes alef');
select is(
  private.norm(U&'\0627\0644\0642\0631\0622\0646'),
  U&'\0627\0644\0642\0631\0627\0646',
  'norm 20: alef with madda becomes alef');
select is(
  private.norm(U&'\0623\062D\0645\062F \0625\0628\0631\0627\0647\064A\0645 \0622\0644 \0645\0648\0633\0649 \0641\0627\0637\0645\0629'),
  U&'\0627\062D\0645\062F \0627\0628\0631\0627\0647\064A\0645 \0627\0644 \0645\0648\0633\064A \0641\0627\0637\0645\0647',
  'norm 21: alef, yeh and teh marbuta folding (schema.md example)');
select is(
  private.norm(U&'\0645\0633\0624\0648\0644'),
  U&'\0645\0633\0624\0648\0644',
  'norm 22: waw with hamza is kept');
select is(
  private.norm(U&'\0642\0627\0626\0645\0629'),
  U&'\0642\0627\0626\0645\0647',
  'norm 23: yeh with hamza is kept, teh marbuta becomes heh');
select is(
  private.norm(U&'\0633\0645\0627\0621'),
  U&'\0633\0645\0627\0621',
  'norm 24: hamza on the line is kept');
select is(
  private.norm(U&'\0645\0624\0633\0633\0629 \0627\0644\062E\064A\0631'),
  U&'\0645\0624\0633\0633\0647 \0627\0644\062E\064A\0631',
  'norm 25: waw with hamza inside a phrase (schema.md example)');
select is(
  private.norm(U&'\0645\0635\0637\0641\0649'),
  U&'\0645\0635\0637\0641\064A',
  'norm 26: alef maqsura becomes yeh');
select is(
  private.norm(U&'\0639\0644\0649'),
  U&'\0639\0644\064A',
  'norm 27: alef maqsura in a short word');
select is(
  private.norm(U&'\0645\062F\0631\0633\0629'),
  U&'\0645\062F\0631\0633\0647',
  'norm 28: teh marbuta becomes heh');
select is(
  private.norm(U&'\0627\0654\062D\0645\062F'),
  U&'\0627\062D\0645\062F',
  'norm 29: NFC first: alef + combining hamza above folds to alef');
select is(
  private.norm(U&'\0627\0653\0644'),
  U&'\0627\0644',
  'norm 30: NFC first: alef + combining madda folds to alef');
select is(
  private.norm(U&'\0627\0655\0633'),
  U&'\0627\0633',
  'norm 31: NFC first: alef + combining hamza below folds to alef');
select is(
  private.norm(U&'\0645\0633\0648\0654\0648\0644'),
  U&'\0645\0633\0624\0648\0644',
  'norm 32: NFC first: waw + combining hamza above composes and is kept');
select is(
  private.norm(U&'\0642\0627\064A\0654\062F'),
  U&'\0642\0627\0626\062F',
  'norm 33: NFC first: yeh + combining hamza above composes and is kept');
select is(
  private.norm(U&'\06A9\062A\0627\0628\06CC'),
  U&'\06A9\062A\0627\0628\06CC',
  'norm 34: Farsi yeh and keheh are not folded');
select is(
  private.norm(U&'\FEFB'),
  U&'\FEFB',
  'norm 35: presentation forms are not decomposed (NFC, not NFKC)');
select is(
  private.norm(U&'\0645\0633\062C\062F\060C \0645\062F\0631\0633\0629\061B \0645\0627\0630\0627\061F'),
  U&'\0645\0633\062C\062F\060C \0645\062F\0631\0633\0647\061B \0645\0627\0630\0627\061F',
  'norm 36: Arabic punctuation is kept');
select is(
  private.norm(U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'),
  U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669',
  'norm 37: Arabic-Indic digits are untouched');
select is(
  private.norm(U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9'),
  U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
  'norm 38: Extended Arabic-Indic digits are untouched');
select is(
  private.norm(U&'\0645\0633\062C\062F 12 \0661\0662'),
  U&'\0645\0633\062C\062F 12 \0661\0662',
  'norm 39: ASCII and Arabic-Indic digits side by side');
select is(
  private.norm(U&'  a\0009b\000Ac\000D\000Ad\00A0e\2003f\3000g\2009\200Ah\202Fi\205Fj\1680k\0085l\2028m\2029n\000Bo\000Cp\2000q '),
  'a b c d e f g h i j k l m n o p q',
  'norm 40: every white-space character becomes one space');
select is(
  private.norm(U&'\0009\000A \0645\0633\062C\062F \00A0\3000'),
  U&'\0645\0633\062C\062F',
  'norm 41: white space around Arabic text is trimmed');
select is(
  private.norm(U&'a\200Bb'),
  'ab',
  'norm 42: zero width space is removed, not turned into a space');
select is(
  private.norm(U&'  Msikiti   wa  \00C9COLE S\00E3o  \00D1and\00FA '),
  'msikiti wa ecole sao nandu',
  'norm 43: Latin accents are stripped (schema.md example)');
select is(
  private.norm(U&'\00C0\00C1\00C2\00C3\00C4\00C5\00C7\00C8\00C9\00CA\00CB\00CC\00CD\00CE\00CF\00D1\00D2\00D3\00D4\00D5\00D6\00D9\00DA\00DB\00DC\00DD\00E0\00E1\00E2\00E3\00E4\00E5\00E7\00E8\00E9\00EA\00EB\00EC\00ED\00EE\00EF\00F1\00F2\00F3\00F4\00F5\00F6\00F9\00FA\00FB\00FC\00FD\00FF'),
  'aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyy',
  'norm 44: Latin-1 accented letters');
select is(
  private.norm(U&'Masjid al-N\016Br'),
  'masjid al-nur',
  'norm 45: macron (transliteration)');
select is(
  private.norm(U&'\1E24asan \1E62\0101li\1E25'),
  'hasan salih',
  'norm 46: dot below (transliteration)');
select is(
  private.norm(U&'\0130stanbul'),
  'istanbul',
  'norm 47: capital I with dot above');
select is(
  private.norm(U&'Nguy\1EC5n'),
  'nguyen',
  'norm 48: Vietnamese stacked accents');
select is(
  private.norm(U&'\01A0\01A1\01AF\01B0'),
  'oouu',
  'norm 49: letters with horn');
select is(
  private.norm(U&'Cafe\0301 Mu\0308nchen'),
  'cafe munchen',
  'norm 50: decomposed (NFD) Latin input');
select is(
  private.norm(U&'x\0301y\0323'),
  'xy',
  'norm 51: stray combining marks are dropped');
select is(
  private.norm(U&'\0628\0301'),
  U&'\0628',
  'norm 52: Latin combining mark on an Arabic letter is dropped');
select is(
  private.norm(U&'\200Fabc\200E'),
  'abc',
  'norm 53: bidi marks LRM and RLM are removed');
select is(
  private.norm(U&'a\200Cb\200Dc'),
  'abc',
  'norm 54: zero width joiner and non-joiner are removed');
select is(
  private.norm(U&'\FEFF\0645\0633\062C\062F'),
  U&'\0645\0633\062C\062F',
  'norm 55: byte order mark is removed');
select is(
  private.norm(U&'\202Aa\202Bb\202Cc\202Dd\202Ee\2066f\2067g\2068h\2069'),
  'abcdefgh',
  'norm 56: bidi embeddings and isolates are removed');
select is(
  private.norm(U&'\0645\064E\0633\0652\062C\0650\062F \0627\0644\0646\0651\064F\0648\0631 / Masjid An-N\016Br (TZ-PN-000123)'),
  U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631 / masjid an-nur (tz-pn-000123)',
  'norm 57: mixed scripts in one string');
select is(
  private.norm(U&'Masjid \+01F54C Nur'),
  U&'masjid \+01F54C nur',
  'norm 58: characters outside the BMP are kept');
select is(
  private.norm('A\B "c" ''d'''),
  'a\b "c" ''d''',
  'norm 59: backslash and quotes are kept');
select is(
  private.norm(U&'Caf\00E9\\N\016Br'),
  'cafe\nur',
  'norm 60: backslash between accented letters');

-- Normalising a normalised value changes nothing.
select is_empty(
  $norm_cases$ select v.expected
     from (values
       (''),
       (''),
       ('masjid al-noor'),
       ('shule ya msingi (qur''an) - no. 2, wete!'),
       ('kijiji cha ng''ambo'),
       ('tz-pn-000123'),
       ('+255 712 345 678'),
       ('msikiti wa ijumaa'),
       (U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631'),
       (''),
       (U&'\0628\0633\0645'),
       (U&'\0631\062D\0645\0646'),
       (U&'\0628\0633\0645'),
       (U&'\0628\0628\0628\0628'),
       (U&'\0645\062D\0645\062F'),
       (''),
       (U&'\0645 \062D'),
       (U&'\0631\0627\0633'),
       (U&'\0627\0633\0644\0627\0645'),
       (U&'\0627\0644\0642\0631\0627\0646'),
       (U&'\0627\062D\0645\062F \0627\0628\0631\0627\0647\064A\0645 \0627\0644 \0645\0648\0633\064A \0641\0627\0637\0645\0647'),
       (U&'\0645\0633\0624\0648\0644'),
       (U&'\0642\0627\0626\0645\0647'),
       (U&'\0633\0645\0627\0621'),
       (U&'\0645\0624\0633\0633\0647 \0627\0644\062E\064A\0631'),
       (U&'\0645\0635\0637\0641\064A'),
       (U&'\0639\0644\064A'),
       (U&'\0645\062F\0631\0633\0647'),
       (U&'\0627\062D\0645\062F'),
       (U&'\0627\0644'),
       (U&'\0627\0633'),
       (U&'\0645\0633\0624\0648\0644'),
       (U&'\0642\0627\0626\062F'),
       (U&'\06A9\062A\0627\0628\06CC'),
       (U&'\FEFB'),
       (U&'\0645\0633\062C\062F\060C \0645\062F\0631\0633\0647\061B \0645\0627\0630\0627\061F'),
       (U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'),
       (U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9'),
       (U&'\0645\0633\062C\062F 12 \0661\0662'),
       ('a b c d e f g h i j k l m n o p q'),
       (U&'\0645\0633\062C\062F'),
       ('ab'),
       ('msikiti wa ecole sao nandu'),
       ('aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyy'),
       ('masjid al-nur'),
       ('hasan salih'),
       ('istanbul'),
       ('nguyen'),
       ('oouu'),
       ('cafe munchen'),
       ('xy'),
       (U&'\0628'),
       ('abc'),
       ('abc'),
       (U&'\0645\0633\062C\062F'),
       ('abcdefgh'),
       (U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631 / masjid an-nur (tz-pn-000123)'),
       (U&'masjid \+01F54C nur'),
       ('a\b "c" ''d'''),
       ('cafe\nur')
     ) as v (expected)
     where private.norm(v.expected) is distinct from v.expected $norm_cases$,
  'private.norm() is idempotent on every expected value');

select * from finish();
rollback;
