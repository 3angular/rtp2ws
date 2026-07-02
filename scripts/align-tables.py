#!/usr/bin/env python3
"""Re-pad GitHub markdown tables to aligned column widths, preserving :/: alignment.

Usage: python3 scripts/align-tables.py docs/*.md
Keeps the repo's aligned-table style consistent after editing table cells.
"""
import sys, re

def is_row(l): return l.lstrip().startswith("|")
def cells(l):
    s = l.strip()
    if s.startswith("|"): s = s[1:]
    if s.endswith("|"): s = s[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]  # keep escaped \| inside cells

def is_delim(l):
    if not is_row(l): return False
    return all(re.fullmatch(r":?-+:?", c) for c in cells(l)) and cells(l)

def align_of(c):
    left, right = c.startswith(":"), c.endswith(":")
    return "center" if left and right else "right" if right else "left"

def fmt(rows):
    grid = [cells(r) for r in rows]
    aligns = [align_of(c) for c in grid[1]]
    n = len(aligns)
    grid = [row + [""]*(n-len(row)) for row in grid]
    w = [max(3, max(len(g[i]) for j,g in enumerate(grid) if j!=1)) for i in range(n)]
    out = []
    for j, row in enumerate(grid):
        parts = []
        for i in range(n):
            if j == 1:
                if aligns[i]=="right": parts.append("-"*(w[i]-1)+":")
                elif aligns[i]=="center": parts.append(":"+"-"*(w[i]-2)+":")
                else: parts.append("-"*w[i])
            else:
                c = row[i]
                parts.append(c.rjust(w[i]) if aligns[i]=="right"
                             else c.center(w[i]) if aligns[i]=="center"
                             else c.ljust(w[i]))
        out.append("| " + " | ".join(parts) + " |")
    return out

def reflow(text):
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        if is_row(lines[i]) and i+1 < len(lines) and is_delim(lines[i+1]):
            block = [lines[i], lines[i+1]]; i += 2
            while i < len(lines) and is_row(lines[i]):
                block.append(lines[i]); i += 1
            out.extend(fmt(block))
        else:
            out.append(lines[i]); i += 1
    return "\n".join(out)

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as f: src = f.read()
    with open(path, "w", encoding="utf-8") as f: f.write(reflow(src))
    print("aligned", path)
