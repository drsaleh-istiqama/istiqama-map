/**
 * Search normalisation: the TypeScript twin of SQL `private.norm(text)`
 * (docs/contracts/schema.md, section 2.1). Both sides must give the same string, otherwise
 * local search, duplicate detection and person matching disagree with the server.
 *
 *   0. Unicode NFC
 *   1. remove tashkeel, tatweel and invisible format characters
 *   2. PostgreSQL `unaccent` (rules of PostgreSQL 17), then remove combining marks
 *      U+0300..U+036F
 *   3. lower-case
 *   4. alef forms to alef, alef maksura to yeh, teh marbuta to heh
 *   5. collapse white space, trim
 *
 * Verified against the database (tests/integration/registry.live.test.ts sweeps these blocks
 * code point by code point): identical for ASCII, Latin-1, Latin Extended-A/B and
 * Additional, IPA, combining marks, Arabic (all blocks incl. presentation forms), Greek and
 * general punctuation. Not mirrored (characters that do not occur in names): `unaccent`
 * rules of the letter-like, enclosed, CJK-unit and full-width blocks, and lower-casing that
 * depends on the Unicode version of the database locale (Greek U+037F / U+03F4, Cherokee,
 * Georgian, …).
 *
 * This file is pure ASCII on purpose: every non-ASCII character is written as a code point
 * number, so no editor or tool can silently change a range.
 */

type Range = number | readonly [number, number];

const esc = (cp: number): string => '\\u{' + cp.toString(16) + '}';
const classBody = (ranges: readonly Range[]): string =>
  ranges.map((r) => (typeof r === 'number' ? esc(r) : esc(r[0]) + '-' + esc(r[1]))).join('');

/** Step 1: tashkeel, superscript alef, Quranic marks, tatweel, zero-width and bidi controls. */
const STRIP_RE = new RegExp(
  '[' +
    classBody([
      [0x064b, 0x065f],
      0x0670,
      [0x06d6, 0x06ed],
      0x0640,
      [0x200b, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
      0xfeff,
    ]) +
    ']',
  'gu',
);

/** Characters that an `unaccent` rule may rewrite (superset; the map decides). */
const UNACCENT_RE = new RegExp(
  '[' +
    classBody([
      [0x00a0, 0x02ff],
      [0x0386, 0x03ce],
      0x0401,
      0x0451,
      [0x1e00, 0x1fff],
      [0x2010, 0x20ff],
      [0xfb00, 0xfb06],
    ]) +
    ']',
  'gu',
);

const COMBINING_RE = new RegExp('[' + classBody([[0x0300, 0x036f]]) + ']', 'gu');

/** Step 4 source characters: alef with hamza above / below, alef with madda, alef maksura, teh marbuta. */
const FOLD_RE = new RegExp('[' + classBody([0x0623, 0x0625, 0x0622, 0x0649, 0x0629]) + ']', 'gu');
const ALEF = String.fromCodePoint(0x0627);
const YEH = String.fromCodePoint(0x064a);
const HEH = String.fromCodePoint(0x0647);
const FOLD: Record<number, string> = {
  0x0623: ALEF,
  0x0625: ALEF,
  0x0622: ALEF,
  0x0649: YEH,
  0x0629: HEH,
};

/** Step 5: the white-space characters of the SQL regular expression. */
const SPACE_RE = new RegExp(
  '[' +
    classBody([
      [0x0009, 0x000d],
      0x0020,
      0x0085,
      0x00a0,
      0x1680,
      [0x2000, 0x200a],
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
    ]) +
    ']+',
  'gu',
);

/**
 * `unaccent` rules whose result is the canonical decomposition without combining marks
 * (hex code points and ranges, taken from PostgreSQL's unaccent.rules).
 */
const NFD_RULES =
  'c0-c5,c7-cf,d1-d6,d9-dd,e0-e5,e7-ef,f1-f6,f9-fd,ff-10f,112-125,128-130,134-137,139-13e,' +
  '143-148,14c-151,154-165,168-17e,1a0-1a1,1af-1b0,1cd-1dc,1de-1e1,1e6-1ed,1f0,1f4-1f5,' +
  '1f8-1fb,200-21b,21e-21f,226-233,386,388-38a,38c,38e-390,3aa-3b0,3ca-3ce,401,451,' +
  '1e00-1e99,1ea0-1ef9,1f00-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,' +
  '1f5f-1f70,1f72,1f74,1f76,1f78,1f7a,1f7c,1f80-1fb4,1fb6-1fba,1fbc,1fc2-1fc4,1fc6-1fc8,' +
  '1fca,1fcc,1fd0-1fd2,1fd6-1fda,1fe0-1fe2,1fe4-1fea,1fec,1ff2-1ff4,1ff6-1ff8,1ffa,1ffc';

/**
 * `unaccent` rules that are not a plain decomposition (ligatures, stroked letters,
 * typographic punctuation). Format: `<code point in base 36>=<replacement>` joined by `;`,
 * with `_` for an apostrophe, `#` for a double quote and `%` for a back-tick.
 * Covered blocks: U+00A0..U+02FF, U+1E00..U+1EFF, U+2010..U+20FF, U+FB00..U+FB06. Rules of other
 * blocks (letter-like symbols, enclosed and full-width forms, CJK units) are not mirrored:
 * such characters do not occur in names and stay unchanged here.
 */
const EXPLICIT_RULES =
  '4h=!;4p=(C);4r=<<;4t=-;4u=(R);4x=+/-;57=>>;58= 1/4;59= 1/2;5a= 3/4;5b=?;5i=AE;5s=D;5z=*;' +
  '60=O;66=TH;67=ss;6e=ae;6o=d;6v=/;6w=o;72=th;7k=D;7l=d;86=H;87=h;8h=i;8i=IJ;8j=ij;8o=q;' +
  '8v=L;8w=l;8x=L;8y=l;95=_n;96=N;97=n;9e=OE;9f=oe;9y=T;9z=t;an=s;ao=b;ap=B;aq=B;ar=b;av=C;' +
  'aw=c;ax=D;ay=D;az=D;b0=d;b4=E;b5=F;b6=f;b7=G;b9=hv;ba=I;bb=I;bc=K;bd=k;be=l;bh=N;bi=n;' +
  'bm=OI;bn=oi;bo=P;bp=p;bv=t;bw=T;bx=t;by=T;c2=V;c3=Y;c4=y;c5=Z;c6=z;ck=DZ;cl=Dz;cm=dz;' +
  'cn=LJ;co=Lj;cp=lj;cq=NJ;cr=Nj;cs=nj;dg=G;dh=g;dt=DZ;du=Dz;dv=dz;f5=d;f8=Z;f9=z;fo=l;fp=n;' +
  'fq=t;fr=j;fs=db;ft=qp;fu=A;fv=C;fw=c;fx=L;fy=T;fz=s;g0=z;g3=B;g4=U;g6=E;g7=e;g8=J;g9=j;' +
  'gc=R;gd=r;ge=Y;gf=y;gj=b;gl=c;gm=d;gn=d;gr=e;gv=j;gw=g;gx=g;gy=G;h2=h;h3=h;h4=i;h6=I;' +
  'h7=l;h8=l;h9=l;hd=m;he=n;hf=n;hg=N;hi=OE;ho=r;hp=r;hq=r;hs=R;hu=s;i0=t;i1=u;i3=v;i7=Y;' +
  'i8=z;i9=z;ih=B;ij=G;ik=H;il=j;in=L;io=q;ir=dz;it=dz;iu=ts;iy=ls;iz=lz;jd=_;je=#;jf=_;' +
  'jg=_;jh=_;jm=<;jn=>;jo=^;jq=^;js=_;jv=%;k0=:;k6=+;k7=-;kc=~;61m=a;61o=s;61p=s;61q=SS;' +
  '64a=LL;64b=ll;64c=V;64d=v;64e=Y;64f=y;6c0=-;6c1=-;6c2=-;6c3=-;6c4=-;6c5=-;6c6=||;6c8=_;' +
  '6c9=_;6ca=,;6cb=_;6cc=#;6cd=#;6ce=,,;6cf=#;6ck=.;6cl=..;6cm=...;6cy=_;6cz=#;6d5=<;6d6=>;' +
  '6d8=!!;6dg=/;6dh=[;6di=];6dj=??;6dk=?!;6dl=!?;6dq=*;6g0=CE;6g2=Cr;6g3=Fr.;6g4=L.;6g7=Pts;' +
  '6gp=Rs;6gq=TL;6hp=;6hq=;6hr=;6hs=;6hu=;6hv=;6hw=;1dkw=ff;1dkx=fi;1dky=fl;1dkz=ffi;' +
  '1dl0=ffl;1dl1=st;1dl2=st';

let unaccentMap: Map<number, string> | null = null;

function buildUnaccentMap(): Map<number, string> {
  const map = new Map<number, string>();
  for (const part of NFD_RULES.split(',')) {
    const [a, b] = part.split('-');
    const from = parseInt(a ?? '', 16);
    const to = b === undefined ? from : parseInt(b, 16);
    for (let cp = from; cp <= to; cp++) {
      const ch = String.fromCodePoint(cp);
      map.set(cp, ch.normalize('NFD').replace(COMBINING_RE, ''));
    }
  }
  for (const entry of EXPLICIT_RULES.split(';')) {
    const eq = entry.indexOf('=');
    const cp = parseInt(entry.slice(0, eq), 36);
    const out = entry
      .slice(eq + 1)
      .replace(/_/g, "'")
      .replace(/#/g, '"')
      .replace(/%/g, '`');
    map.set(cp, out);
  }
  return map;
}

function unaccentChar(ch: string): string {
  if (unaccentMap === null) unaccentMap = buildUnaccentMap();
  const out = unaccentMap.get(ch.codePointAt(0) ?? -1);
  return out === undefined ? ch : out;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/**
 * Normalises text for search and matching. `norm('')` is `''`; unlike SQL there is no NULL:
 * callers pass `value ?? ''`.
 */
export function norm(text: string): string {
  if (text === '') return '';
  if (isAscii(text)) {
    return text.toLowerCase().replace(SPACE_RE, ' ').trim();
  }
  return text
    .normalize('NFC')
    .replace(STRIP_RE, '')
    .replace(UNACCENT_RE, unaccentChar)
    .replace(COMBINING_RE, '')
    .toLowerCase()
    .replace(FOLD_RE, (ch) => FOLD[ch.codePointAt(0) ?? 0] ?? ch)
    .replace(SPACE_RE, ' ')
    .replace(/^ +| +$/g, '');
}

/** `norm()` for nullable columns: `null`/`undefined` become the empty string. */
export function normOrEmpty(text: string | null | undefined): string {
  return text == null ? '' : norm(text);
}
