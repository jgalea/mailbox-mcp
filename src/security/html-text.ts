// Converts an HTML email body to the text a human would actually see in a mail
// client. Anything the client would not render (hidden elements, comments,
// scripts, styles, template/noscript) is dropped and counted, so the caller
// can warn that hidden text was removed.

export interface VisibleText {
  text: string;
  hiddenChars: number;
}

const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "head", "template", "noscript", "title", "svg", "iframe", "object"]);
const BLOCK_ELEMENTS = new Set(["p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "hr", "ul", "ol", "pre", "section", "article", "header", "footer", "center", "dd", "dt", "address"]);
const CELL_ELEMENTS = new Set(["td", "th"]);

const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  transparent: [-1, -1, -1], ivory: [255, 255, 240], snow: [255, 250, 250], whitesmoke: [245, 245, 245],
  ghostwhite: [248, 248, 255], floralwhite: [255, 250, 240], aliceblue: [240, 248, 255],
};

type Rgb = [number, number, number];

interface StyleFacts {
  hidden: boolean;
  color?: Rgb;
  background?: Rgb;
}

interface OpenElement {
  tag: string;
  hidden: boolean;
  background?: Rgb;
}

function parseColor(raw: string | undefined): Rgb | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase().replace(/\s*!important\s*$/, "");
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return undefined;
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return undefined;
}

function sameColor(a: Rgb, b: Rgb): boolean {
  if (a[0] < 0 || b[0] < 0) return false;
  return Math.abs(a[0] - b[0]) <= 24 && Math.abs(a[1] - b[1]) <= 24 && Math.abs(a[2] - b[2]) <= 24;
}

function parseDeclarations(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    out.set(decl.slice(0, idx).trim().toLowerCase(), decl.slice(idx + 1).trim());
  }
  return out;
}

function numberOf(value: string): number | undefined {
  const m = value.trim().match(/^(-?\d*\.?\d+)/);
  return m ? Number(m[1]) : undefined;
}

function factsFromDeclarations(decls: Map<string, string>): StyleFacts {
  const facts: StyleFacts = { hidden: false };
  const display = decls.get("display")?.toLowerCase();
  if (display?.startsWith("none")) facts.hidden = true;
  if (decls.get("visibility")?.toLowerCase().startsWith("hidden")) facts.hidden = true;
  if (decls.get("mso-hide")?.toLowerCase().startsWith("all")) facts.hidden = true;
  const opacity = numberOf(decls.get("opacity") ?? "");
  if (opacity !== undefined && opacity <= 0.05) facts.hidden = true;
  const fontSize = decls.get("font-size");
  if (fontSize) {
    const n = numberOf(fontSize);
    if (n !== undefined) {
      const unit = fontSize.replace(/^[-\d.\s]+/, "").toLowerCase();
      if (n === 0) facts.hidden = true;
      else if ((unit === "px" || unit === "pt") && n <= 1) facts.hidden = true;
      else if ((unit === "em" || unit === "rem") && n <= 0.1) facts.hidden = true;
      else if (unit === "%" && n <= 5) facts.hidden = true;
    }
  }
  const overflow = decls.get("overflow")?.toLowerCase();
  if (overflow === "hidden") {
    for (const prop of ["max-height", "height", "width", "max-width"]) {
      const n = numberOf(decls.get(prop) ?? "");
      if (n !== undefined && n <= 0) facts.hidden = true;
    }
  }
  const indent = numberOf(decls.get("text-indent") ?? "");
  if (indent !== undefined && indent <= -999) facts.hidden = true;
  if (decls.get("position")?.toLowerCase() === "absolute") {
    for (const prop of ["left", "top"]) {
      const n = numberOf(decls.get(prop) ?? "");
      if (n !== undefined && n <= -999) facts.hidden = true;
    }
  }
  const color = parseColor(decls.get("color"));
  if (color) facts.color = color;
  const bg = parseColor(decls.get("background-color")) ?? parseColor((decls.get("background") ?? "").split(/\s+/)[0]);
  if (bg) facts.background = bg;
  return facts;
}

interface StyleRule {
  kind: "tag" | "class" | "id";
  key: string;
  tag?: string;
  facts: StyleFacts;
}

function parseStylesheet(css: string, into: StyleRule[]): void {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const facts = factsFromDeclarations(parseDeclarations(m[2]));
    if (!facts.hidden && !facts.color && !facts.background) continue;
    for (const selector of m[1].split(",")) {
      const simple = selector.trim().split(/\s+/).pop() ?? "";
      const cls = simple.match(/^([a-z0-9-]*)\.([\w-]+)$/i);
      const id = simple.match(/^([a-z0-9-]*)#([\w-]+)$/i);
      const tag = simple.match(/^([a-z][a-z0-9]*)$/i);
      if (cls) into.push({ kind: "class", key: cls[2], tag: cls[1].toLowerCase() || undefined, facts });
      else if (id) into.push({ kind: "id", key: id[2], tag: id[1].toLowerCase() || undefined, facts });
      else if (tag) into.push({ kind: "tag", key: tag[1].toLowerCase(), facts });
    }
  }
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function mergeFacts(target: StyleFacts, extra: StyleFacts): void {
  if (extra.hidden) target.hidden = true;
  if (extra.color) target.color = extra.color;
  if (extra.background) target.background = extra.background;
}

function elementFacts(tag: string, attrs: Map<string, string>, rules: StyleRule[]): StyleFacts {
  const facts: StyleFacts = { hidden: false };
  const classes = new Set((attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
  const id = attrs.get("id");
  for (const rule of rules) {
    if (rule.tag && rule.tag !== tag) continue;
    if (rule.kind === "tag" && rule.key === tag) mergeFacts(facts, rule.facts);
    else if (rule.kind === "class" && classes.has(rule.key)) mergeFacts(facts, rule.facts);
    else if (rule.kind === "id" && id === rule.key) mergeFacts(facts, rule.facts);
  }
  if (attrs.has("hidden")) facts.hidden = true;
  if (attrs.get("aria-hidden")?.toLowerCase() === "true") facts.hidden = true;
  const bgAttr = parseColor(attrs.get("bgcolor"));
  if (bgAttr) facts.background = bgAttr;
  const colorAttr = parseColor(attrs.get("color"));
  if (colorAttr) facts.color = colorAttr;
  const style = attrs.get("style");
  if (style) mergeFacts(facts, factsFromDeclarations(parseDeclarations(style)));
  return facts;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  euro: "€", pound: "£", yen: "¥", trade: "™", bull: "•", middot: "·", zwnj: "", zwj: "", shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1].toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[ref.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function collapse(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ");
}

function visibleLength(text: string): number {
  return collapse(text).trim().length;
}

export function htmlToVisibleText(html: string): VisibleText {
  const rules: StyleRule[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleRe.exec(html))) parseStylesheet(sm[1], rules);

  const stack: OpenElement[] = [];
  let out = "";
  let hiddenChars = 0;
  let pos = 0;

  const currentlyHidden = () => stack.length > 0 && stack[stack.length - 1].hidden;
  const push = (text: string) => {
    if (!text) return;
    if (!text.trim() && (out === "" || out.endsWith("\n"))) return;
    out += text;
  };
  const newline = () => {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  };
  const currentBackground = (): Rgb => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const bg = stack[i].background;
      if (bg) return bg;
    }
    return [255, 255, 255];
  };
  const emitText = (raw: string) => {
    if (!raw) return;
    if (currentlyHidden()) {
      hiddenChars += visibleLength(raw);
      return;
    }
    push(collapse(raw));
  };

  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) {
      emitText(html.slice(pos));
      break;
    }
    emitText(html.slice(pos, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const close = end < 0 ? html.length : end + 3;
      hiddenChars += visibleLength(html.slice(lt + 4, end < 0 ? html.length : end));
      pos = close;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt);
      pos = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      pos = end < 0 ? html.length : end + 1;
      continue;
    }

    const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/.exec(html.slice(lt));
    if (!tagMatch) {
      emitText("<");
      pos = lt + 1;
      continue;
    }
    const [whole, slash, rawName, rawAttrs] = tagMatch;
    const tag = rawName.toLowerCase();
    pos = lt + whole.length;

    if (slash) {
      let wasHidden = currentlyHidden();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          wasHidden = stack[i].hidden;
          stack.length = i;
          break;
        }
      }
      if (wasHidden) continue;
      if (BLOCK_ELEMENTS.has(tag)) newline();
      else if (CELL_ELEMENTS.has(tag)) push("\t");
      continue;
    }

    if (DROP_WITH_CONTENT.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(pos);
      const m = closeRe.exec(rest);
      const inner = m ? rest.slice(0, m.index) : rest;
      if (tag === "template" || tag === "noscript") hiddenChars += visibleLength(inner.replace(/<[^>]*>/g, " "));
      pos = m ? pos + m.index + m[0].length : html.length;
      continue;
    }

    const attrs = parseAttributes(rawAttrs.replace(/\/\s*$/, ""));
    const facts = elementFacts(tag, attrs, rules);
    const parentHidden = currentlyHidden();
    let hidden = parentHidden || facts.hidden;
    const background = facts.background ?? currentBackground();
    if (!hidden && facts.color && sameColor(facts.color, background)) hidden = true;

    if (tag === "br") {
      if (!hidden) out += "\n";
      continue;
    }
    if (BLOCK_ELEMENTS.has(tag) && !hidden) newline();
    if (tag === "img" && !hidden) {
      const alt = attrs.get("alt");
      if (alt) push(`[image: ${collapse(alt)}]`);
    }
    if (tag === "a" && !hidden) {
      const href = (attrs.get("href") ?? "").trim();
      if (/^(https?:|mailto:)/i.test(href)) {
        const closeRe = /<\/a\s*>/i;
        const rest = html.slice(pos);
        const m = closeRe.exec(rest);
        const innerHtml = m ? rest.slice(0, m.index) : rest;
        const innerText = collapse(innerHtml.replace(/<[^>]*>/g, " ")).trim();
        if (innerText && !innerText.includes(href)) {
          push(`${innerText} (${href})`);
          pos = m ? pos + m.index + m[0].length : html.length;
          continue;
        }
      }
    }
    if (VOID_ELEMENTS.has(tag) || rawAttrs.trim().endsWith("/")) continue;
    stack.push({ tag, hidden, background: facts.background });
  }

  const text = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, (m) => (m.includes("\t") ? "  " : " ")).trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, hiddenChars };
}
