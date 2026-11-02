"""Layout-aware parser for Gauhati High Court cause lists (daily / supplementary / lawazima / regular hearing).

Two layouts were observed in the live PDFs (2026-11-02) and are both handled by one column-inference strategy
(documented in docs/parser.md):

  Layout A  - header block (`[AT 10:30 AM]`, `BEFORE:`, judges, `COURT NO: n`, `[BENCH]`), a dashed rule, a
              column-header row (`Sr.No. Case Number | Main Parties | Petitioner Advocate | Respondent Advocate`),
              a second dashed rule, then rows. Serials are bare integers. Section headings are centred.
  Layout B  - (Kohima-bench supplementary section) same four columns but no header row and no dashed rules,
              serials like `1.`, `[ COURT NO: 9 ]`, upper-case `VERSUS`.

Columns are located from the data (case-number x-position, plus header-row positions when present, else x-clusters),
never from hard-coded coordinates. Anything that cannot be parsed confidently is kept (raw text + flags) and marked
NEEDS_REVIEW; nothing is invented.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional

from ..config import Settings
from ..models.schemas import Bench, Entry, Line, PageData, Person
from .normalize import normalize_case_number

RULE_DASH = re.compile(r"^-{8,}$")
RULE_EQ = re.compile(r"^={8,}$")
FOOTER = re.compile(r"^\s*\d+\s*/\s*\d+\s*$")
AT_RE = re.compile(r"^\[?\s*AT\s+\d{1,2}[:.]\d{2}\s*[AP]\.?M\.?\s*\]?$", re.I)
BEFORE_RE = re.compile(r"^\[?\s*BEFORE\s*:?\s*\]?$", re.I)
COURT_RE = re.compile(r"^\[?\s*COURT\s*(?:NO\.?|NUMBER)?\s*[:.\-]?\s*([A-Za-z0-9]+)\s*\]?$", re.I)
JUDGE_RE = re.compile(r"HONOURABLE|HON'BLE|\bJUSTICE\b|OFFICER ON SPECIAL DUTY|REGISTRAR", re.I)
HEADER_ZONE = re.compile(r"^(Sr\.?\s*No\.?|Main Parties|Petitioner Advocate|Respondent Advocate)", re.I)
SERIAL = re.compile(r"^(\d{1,5})\.?$")
VERSUS = re.compile(r"^(?:versus|vs\.?|v/s)$", re.I)
WITH = re.compile(r"^WITH$", re.I)
IN_REF = re.compile(r"^in\s+(.+)$", re.I)
# A line that starts like a NEW advocate (title, counsel designation or dotted acronym) is never a wrapped tail.
NEW_ADVOCATE = re.compile(
    r"^(?:MR|MRS|MS|MISS|MX|SMT|SMTI|SRI|SHRI|DR|ADV|ADVOCATE|SC|GA|PP|AAG|ASG|AG|CGC|PETITIONER|RESPONDENT|IN\s+PERSON)\b"
    r"|^[A-Z]{1,8}(?:\.[A-Z]{1,8})+\.?(?:\(|,|$)",
    re.I,
)
MONTHS = "JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER".split()
DATE_A = re.compile(r"(\d{1,2})(?:ST|ND|RD|TH)?\s*,?\s+(?:DAY\s+OF\s+)?(" + "|".join(MONTHS) + r")\s*,?\s+(\d{4})", re.I)


def _strip_brackets(t: str) -> str:
    return re.sub(r"\s+", " ", t.strip().strip("[]").strip())


# ----------------------------------------------------------------------------------------------- rows


@dataclass
class Row:
    page: int
    y: float
    lines: list[Line]

    @property
    def text(self) -> str:
        return " ".join(l.text.strip() for l in self.lines)


def group_rows(page: PageData, tol: float = 3.0) -> list[Row]:
    rows: list[Row] = []
    for ln in sorted(page.lines, key=lambda l: (l.y0, l.x0)):
        if rows and abs(ln.y0 - rows[-1].y) <= tol:
            rows[-1].lines.append(ln)
        else:
            rows.append(Row(page.page_number, ln.y0, [ln]))
    for r in rows:
        r.lines.sort(key=lambda l: l.x0)
    return rows


# --------------------------------------------------------------------------------------------- columns


@dataclass
class Columns:
    case_x: float
    parties_x: float
    pet_x: Optional[float]
    resp_x: Optional[float]
    page_width: float
    parties_text_x: float
    source: str  # "header" | "carried" | "clusters"

    def col(self, x0: float) -> str:
        if x0 < self.case_x - 8:
            return "serial"
        if x0 < self.parties_x - 8:
            return "case"
        if self.pet_x is None or x0 < self.pet_x - 8:
            return "parties"
        if self.resp_x is None or x0 < self.resp_x - 8:
            return "pet"
        return "resp"

    def right_edge(self, col: str) -> float:
        if col == "pet":
            return (self.resp_x if self.resp_x is not None else self.page_width) - 6
        if col == "resp":
            return self.page_width - 14
        if col == "parties":
            return (self.pet_x if self.pet_x is not None else self.page_width) - 6
        return self.parties_x - 6


def _mode(values: list[float]) -> Optional[float]:
    if not values:
        return None
    c = Counter(round(v) for v in values)
    return float(c.most_common(1)[0][0])


def infer_columns(page: PageData, prev: Optional[Columns]) -> Optional[Columns]:
    lines = page.lines
    w = page.width
    case_lines = [l for l in lines if l.x0 < w * 0.45 and normalize_case_number(l.text.strip())]
    case_x = _mode([l.x0 for l in case_lines])
    if case_x is None:
        return prev
    header: dict[str, float] = {}
    for l in lines:
        t = l.text.strip().lower()
        if t == "main parties":
            header["parties"] = l.x0
        elif t == "petitioner advocate":
            header["pet"] = l.x0
        elif t == "respondent advocate":
            header["resp"] = l.x0
    if "parties" in header and "pet" in header:
        cols = Columns(case_x, header["parties"] - 2, header["pet"] - 2, header.get("resp", w) - 2 if "resp" in header else None, w, 0, "header")
    elif prev and abs(prev.case_x - case_x) <= 6:
        cols = Columns(case_x, prev.parties_x, prev.pet_x, prev.resp_x, w, 0, "carried")
    else:
        xs = sorted(l.x0 for l in lines if l.x0 > case_x + 40 and not SERIAL.match(l.text.strip()))
        clusters: list[list[float]] = []
        for x in xs:
            if clusters and x - clusters[-1][-1] <= 12:
                clusters[-1].append(x)
            else:
                clusters.append([x])
        # Keep clusters with real support (stray headings are sparse). Small pages can have as few as 2 lines in the
        # respondent-advocate column, so a 2-line cluster counts; a single isolated line far to the right of the
        # others is also accepted as the third column (it cannot be a centred heading, which sits between columns).
        support = [c for c in clusters if len(c) >= max(2, int(0.08 * len(xs)))]
        if support and len(support) < 3:
            far = [c for c in clusters if c not in support and c[0] > support[-1][-1] + 40]
            support += far[:1]
        pos = [_mode(c) for c in support][:3]
        if len(pos) < 2:
            return prev
        cols = Columns(case_x, pos[0] or 0, pos[1], pos[2] if len(pos) > 2 else None, w, 0, "clusters")
    cols.parties_text_x = _mode([l.x0 for l in lines if cols.col(l.x0) == "parties"]) or cols.parties_x
    return cols


# ------------------------------------------------------------------------------------------ item model


@dataclass
class Item:
    serial: Optional[str]
    bench: Optional[Bench]
    heading: Optional[str]
    lines: list[Line] = field(default_factory=list)
    cols: dict[str, list[Line]] = field(default_factory=lambda: {"serial": [], "case": [], "parties": [], "pet": [], "resp": []})
    with_prefix: bool = False

    def add(self, col: str, ln: Line) -> None:
        self.lines.append(ln)
        self.cols[col].append(ln)


@dataclass
class HeaderDraft:
    sitting_time: Optional[str] = None
    court: Optional[str] = None
    bench: Optional[str] = None
    judges: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    heading: Optional[str] = None
    bracket: Optional[list[str]] = None  # accumulating multi-line [ ... ] text

    def to_bench(self) -> Bench:
        return Bench(court_label_raw=self.court, bench_label_raw=self.bench, judges=self.judges, notes=self.notes, sitting_time_raw=self.sitting_time)


# --------------------------------------------------------------------------------------------- parser


class CauseListParser:
    """Stateful, single-pass parser over rows in reading order."""

    def __init__(self, settings: Settings):
        self.s = settings
        self.mode = "PREAMBLE"
        self.cols: Optional[Columns] = None
        self.draft = HeaderDraft()
        self.rules_seen = 0
        self.bench: Optional[Bench] = None
        self.heading: Optional[str] = None
        self.heading_acc: list[str] = []
        self.last_was_heading = False
        self.item: Optional[Item] = None
        self.carry_with = False
        self.entries: list[Entry] = []
        self.meta: dict = {"preamble": [], "pdf_date_text": None, "benches": 0, "layout_sources": Counter()}
        self._page_w = 595.0

    # ---- public --------------------------------------------------------------------------------
    def parse(self, pages: list[PageData]) -> list[Entry]:
        for page in pages:
            if page.status not in ("OK", "OCR_USED"):
                continue
            self._page_w = page.width
            self.cols = infer_columns(page, self.cols)
            if self.cols:
                self.meta["layout_sources"][self.cols.source] += 1
            for row in group_rows(page):
                self._row(row, page)
        self._finish_item()
        for i, e in enumerate(self.entries):
            e.entry_index = i
        return self.entries

    # ---- row dispatch ------------------------------------------------------------------------------
    def _row(self, row: Row, page: PageData) -> None:
        texts = [l.text.strip() for l in row.lines]
        if len(row.lines) == 1 and FOOTER.match(texts[0]) and row.lines[0].y0 > page.height - 90:
            return
        # A new sitting context ("[AT 10:30 AM]" / "BEFORE:") can begin in any mode.
        has_at = any(AT_RE.match(t) for t in texts)
        if has_at or any(BEFORE_RE.match(t) for t in texts):
            if self.mode != "HEADER":
                self._finish_item()
                self._start_header()
            if has_at:
                self.draft.sitting_time = _strip_brackets(next(t for t in texts if AT_RE.match(t)))
            return
        if any(RULE_EQ.match(t) for t in texts):
            self._finish_item()
            if self.mode == "TABLE":
                self.mode = "NOTE"
            return
        if self.mode == "PREAMBLE":
            self._preamble(row)
        elif self.mode == "HEADER":
            self._header(row)
        elif self.mode == "TABLE":
            self._table(row)
        # NOTE: ignored (e.g. "LEAVE NOTE OF ADVOCATES" tables)

    def _start_header(self) -> None:
        self.mode = "HEADER"
        self.draft = HeaderDraft()
        self.rules_seen = 0
        self.heading = None
        self.heading_acc = []

    # ---- preamble -------------------------------------------------------------------------------------
    def _preamble(self, row: Row) -> None:
        t = row.text.strip()
        if t:
            self.meta["preamble"].append(t)
            m = DATE_A.search(t.upper())
            if m and not self.meta["pdf_date_text"]:
                self.meta["pdf_date_text"] = _normalize_pdf_date(m)

    # ---- header (bench context) ------------------------------------------------------------------------
    def _header(self, row: Row) -> None:
        d = self.draft
        # Layout B has no dashed rules: the first row holding a case number starts the table.
        # (Layout A reaches the table through its second dashed rule; the header zone never contains case numbers.)
        if self.rules_seen <= 1 and any(normalize_case_number(l.text.strip()) for l in row.lines if l.x0 < 0.45 * self._page_w):
            self._enter_table()
            self._table(row)
            return
        for ln in row.lines:
            t = ln.text.strip()
            if not t:
                continue
            if RULE_DASH.match(t):
                self.rules_seen += 1
                if self.rules_seen >= 2:
                    self._enter_table()
                    return
                continue
            if HEADER_ZONE.match(t):
                continue
            if d.bracket is not None:  # inside a multi-line [ ... ]
                d.bracket.append(t.rstrip("]").strip())
                if t.endswith("]"):
                    self._close_bracket()
                continue
            if t.startswith("[") and not t.endswith("]"):
                d.bracket = [t.lstrip("[").strip()]
                continue
            inner = _strip_brackets(t) if t.startswith("[") else t
            if COURT_RE.match(inner):
                d.court = re.sub(r"\s+", " ", inner)
            elif JUDGE_RE.search(inner) and not t.startswith("["):
                d.judges.append(re.sub(r"\s+", " ", inner))
            elif t.startswith("["):
                self._bracket_text(inner)
            else:
                self._plain_header_text(inner)

    def _bracket_text(self, inner: str) -> None:
        if self.draft.bench is None:
            self.draft.bench = inner
        else:
            self.draft.notes.append(inner)

    def _close_bracket(self) -> None:
        d = self.draft
        parts = [p for p in (d.bracket or []) if p]
        d.bracket = None
        if not parts:
            return
        first = parts[0]
        if COURT_RE.match(first):
            d.court = first
            return
        # "[CIVIL BENCH-I / THIS BENCH WILL TAKE UP ...]": first line is the bench label, the rest are notes.
        # "[THIS BENCH WILL SIT AFTER RISING OF / THE DIVISION BENCH-II ...]": the whole text is a note.
        is_label = re.search(r"\bBENCH\b", first, re.I) and not re.match(r"(THIS|NO|ALL|WILL|THE)\b", first, re.I) and len(first) <= 60
        if is_label and d.bench is None:
            d.bench = first
            d.notes.extend(parts[1:])
        else:
            d.notes.append(" ".join(parts))

    def _plain_header_text(self, text: str) -> None:
        d = self.draft
        if d.court is None and d.bench is None:
            d.bench = text  # e.g. "SPECIAL DIVISION BENCH" (regular-hearing list has no court number)
        elif text.isupper() and len(text) <= 80 and (d.court or d.bench):
            d.heading = (d.heading + " " + text) if d.heading else text
        else:
            d.notes.append(text)

    def _enter_table(self) -> None:
        self.bench = self.draft.to_bench()
        self.meta["benches"] += 1
        self.heading = self.draft.heading
        self.heading_acc = []
        self.last_was_heading = False
        self.mode = "TABLE"

    # ---- table ----------------------------------------------------------------------------------------------
    def _table(self, row: Row) -> None:
        cols = self.cols
        lines = [l for l in row.lines if l.text.strip()]
        if not lines:
            return
        if any(RULE_DASH.match(l.text.strip()) for l in lines):
            return
        if any(HEADER_ZONE.match(l.text.strip()) for l in lines):
            return
        if cols is None:
            self.heading_acc.append(row.text)
            return

        placed = [(cols.col(l.x0), l) for l in lines]
        # Centred section heading: a lone line well inside the parties column, not "Versus".
        if len(placed) == 1:
            c, ln = placed[0]
            t = ln.text.strip()
            if c == "parties" and ln.x0 > cols.parties_text_x + 8 and not VERSUS.match(t):
                self._finish_item()
                if self.last_was_heading:
                    self.heading_acc.append(t)
                else:
                    self.heading_acc = [t]
                self.heading = " ".join(self.heading_acc)
                self.last_was_heading = True
                return
        serial_line = next((l for c, l in placed if c == "serial" and SERIAL.match(l.text.strip())), None)
        has_case_col = any(c == "case" for c, _ in placed)
        if serial_line is not None and has_case_col:
            self._finish_item()
            self.item = Item(SERIAL.match(serial_line.text.strip()).group(1), self.bench, self.heading)  # type: ignore[union-attr]
            self.last_was_heading = False
        elif self.item is None:
            # Text before the first item that is not a heading (rare): treat as a heading fragment.
            self.heading_acc.append(row.text)
            self.heading = " ".join(self.heading_acc)
            return
        else:
            self.last_was_heading = False
        assert self.item is not None
        for c, ln in placed:
            self.item.add(c, ln)

    # ---- item completion ----------------------------------------------------------------------------------------
    def _finish_item(self) -> None:
        item, self.item = self.item, None
        if item is None:
            return
        self.entries.extend(self._build_entries(item))

    def _build_entries(self, item: Item) -> list[Entry]:
        """Split one printed item into entries. A `WITH` row in the case column starts a connected case (its own
        parties/advocates follow it); a trailing `WITH` connects the NEXT item to this one."""
        case_lines = sorted(item.cols["case"], key=lambda l: (l.page, l.y0))
        marks = [(l.page, l.y0) for l in case_lines if WITH.match(l.text.strip())]

        def seg_of(ln: Line) -> int:
            return sum(1 for m in marks if (ln.page, ln.y0) >= (m[0], m[1] - 0.5))

        segs: list[dict[str, list[Line]]] = [{"case": [], "parties": [], "pet": [], "resp": [], "all": []} for _ in range(len(marks) + 1)]
        for ln in item.lines:
            segs[seg_of(ln)]["all"].append(ln)
        for col in ("case", "parties", "pet", "resp"):
            for ln in item.cols[col]:
                segs[seg_of(ln)][col].append(ln)

        out: list[Entry] = []
        trailing_with = False
        for si, seg in enumerate(segs):
            content = [l for l in seg["case"] if not WITH.match(l.text.strip())] + seg["parties"] + seg["pet"] + seg["resp"]
            if not content:
                trailing_with = si > 0 and si == len(segs) - 1
                continue
            entry = self._entry_from(item, seg, item.serial)
            connected = si > 0 or (not out and self.carry_with)
            prev = out[-1] if out else (self.entries[-1] if self.entries else None)
            if connected:
                entry.listing_note_raw = f"WITH; {entry.listing_note_raw}" if entry.listing_note_raw else "WITH"
                if prev is not None and prev.bench == entry.bench and prev.case_number_raw and entry.case_number_raw:
                    _link(prev, entry)
            out.append(entry)
        self.carry_with = trailing_with
        return out

    # ---- single entry ---------------------------------------------------------------------------------------------
    def _entry_from(self, item: Item, seg: dict[str, list[Line]], serial_text: Optional[str]) -> Entry:
        s = self.s
        flags: list[str] = []
        case_raw: Optional[str] = None
        notes: list[str] = []
        connected: list[str] = []
        for ln in sorted(seg["case"], key=lambda l: (l.page, l.y0)):
            t = ln.text.strip()
            if WITH.match(t):
                continue
            if case_raw is None and normalize_case_number(t):
                case_raw = t
                continue
            m = IN_REF.match(t)
            if m:
                ref = normalize_case_number(m.group(1))
                connected.append(ref.normalized if ref else m.group(1).strip())
                notes.append(t)
                continue
            notes.append(t)

        parties = self._parties(seg["parties"], flags)
        adv_pet, w1 = self._advocates(seg["pet"], "PETITIONER", "pet")
        adv_resp, w2 = self._advocates(seg["resp"], "RESPONDENT", "resp")
        if w1 or w2:
            flags.append("ADVOCATE_WRAP_HEURISTIC")

        all_lines = seg["all"] or item.lines
        method = "OCR" if any(l.method == "OCR" for l in all_lines) else "TEXT"
        ocr_conf = min([l.conf for l in all_lines if l.conf is not None], default=None)
        entry = Entry(
            entry_index=0,
            bench=item.bench,
            serial_number=serial_text,
            case_number_raw=case_raw,
            listing_note_raw="; ".join(notes) if notes else None,
            section_heading_raw=item.heading,
            connected_cases=connected,
            page_start=min(l.page for l in all_lines),
            page_end=max(l.page for l in all_lines),
            raw_text=_raw_text(all_lines)[:20000],
            extraction_method=method,
            validation_flags=flags,
            parties=parties,
            advocates=adv_pet + adv_resp,
        )
        from ..validators.validate import validate_entry

        validate_entry(entry, s, ocr_conf)
        return entry

    def _parties(self, lines: list[Line], flags: list[str]) -> list[Person]:
        lines = sorted(lines, key=lambda l: (l.page, l.y0))
        left: list[str] = []
        right: list[str] = []
        seen_versus = False
        for ln in lines:
            t = ln.text.strip()
            if VERSUS.match(t) and not seen_versus:
                seen_versus = True
                continue
            (right if seen_versus else left).append(t)
        people: list[Person] = []
        if seen_versus:
            if left:
                people.append(Person(name_raw=" ".join(left), side="PETITIONER", sequence=0))
            if right:
                people.append(Person(name_raw=" ".join(right), side="RESPONDENT", sequence=1))
            if not left or not right:
                flags.append("PARTY_SIDE_MISSING")
        elif left:
            flags.append("NO_VERSUS")
            people.append(Person(name_raw=" ".join(left), side="UNKNOWN", sequence=0))
        return people

    def _advocates(self, lines: list[Line], side: str, col: str) -> tuple[list[Person], bool]:
        """One advocate per printed line, except when a line is clearly the wrapped tail of the previous one:
        (a) the previous line has an unclosed '(' or (b) the previous line is so close to the column's right edge
        that the first word of the next line could not have fit on it (width heuristic)."""
        lines = sorted(lines, key=lambda l: (l.page, l.y0))
        edge = self.cols.right_edge(col) if self.cols else 9999
        groups: list[list[Line]] = []
        used_heuristic = False
        for ln in lines:
            if groups:
                prev = groups[-1][-1]
                prev_text = " ".join(l.text.strip() for l in groups[-1])
                unclosed = prev_text.count("(") > prev_text.count(")")
                char_w = ln.width / max(1, len(ln.text.strip())) if ln.width else 5.5
                first_word_w = len(ln.text.strip().split(" ")[0]) * char_w
                overflow = prev.x1 + char_w + first_word_w > edge + 2
                new_adv = bool(NEW_ADVOCATE.match(ln.text.strip()))
                if prev.page == ln.page and (unclosed or (overflow and not new_adv)):
                    groups[-1].append(ln)
                    used_heuristic = used_heuristic or (overflow and not unclosed)
                    continue
            groups.append([ln])
        people = [
            Person(name_raw=" ".join(l.text.strip() for l in g), side=side, sequence=i) for i, g in enumerate(groups)
        ]
        return people, used_heuristic


def _link(a: Entry, b: Entry) -> None:
    ca = _norm_ref(a.case_number_raw)
    cb = _norm_ref(b.case_number_raw)
    if cb and cb not in a.connected_cases:
        a.connected_cases.append(cb)
    if ca and ca not in b.connected_cases:
        b.connected_cases.append(ca)


def _norm_ref(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    n = normalize_case_number(raw)
    return n.normalized if n else raw.strip()


def _raw_text(lines: list[Line]) -> str:
    rows: list[list[Line]] = []
    for ln in sorted(lines, key=lambda l: (l.page, l.y0, l.x0)):
        if rows and rows[-1][0].page == ln.page and abs(ln.y0 - rows[-1][0].y0) <= 3:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    return "\n".join(" | ".join(l.text.strip() for l in sorted(r, key=lambda l: l.x0)) for r in rows)


def _normalize_pdf_date(m: re.Match[str]) -> Optional[str]:
    day, mon, year = int(m.group(1)), m.group(2).upper(), int(m.group(3))
    if mon not in MONTHS:
        return None
    return f"{year:04d}-{MONTHS.index(mon) + 1:02d}-{day:02d}"
