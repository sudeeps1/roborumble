"""Shout -> move. all-MiniLM-L6-v2 embeddings over every move's name and aliases when
sentence-transformers is installed, otherwise fuzzy string matching. Both give a 0..1 score.
"""
from __future__ import annotations

import difflib
import re
import threading
from typing import Iterable

import numpy as np

from . import config

FILLER = re.compile(r"\b(i|use|uses|using|cast|casts|do|does|go|now|the|a|an|my|your|please|with|attack|move)\b")


def clean(text: str) -> str:
    t = re.sub(r"[^a-z0-9' ]+", " ", text.lower())
    t = FILLER.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


class Matcher:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.ids: list[str] = []     # move id per row
        self.texts: list[str] = []
        self.vecs: np.ndarray | None = None
        self.model = None
        if config.EMBEDDINGS != "off":
            try:
                from sentence_transformers import SentenceTransformer

                self.model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cpu")
            except Exception as e:  # not installed, or no network for the first download
                print(f"matcher: embeddings off ({type(e).__name__}: {e}); using fuzzy matching")
        self.backend = "embeddings" if self.model else "fuzzy"

    def _embed(self, texts: list[str]) -> np.ndarray:
        return np.asarray(self.model.encode(texts, normalize_embeddings=True, convert_to_numpy=True), dtype=np.float32)

    def add(self, move_id: str, name: str, aliases: Iterable[str]) -> None:
        texts = list(dict.fromkeys(clean(t) for t in [name, *aliases] if t and clean(t)))
        if not texts:
            return
        vecs = self._embed(texts) if self.model else None
        with self.lock:
            self.ids.extend([move_id] * len(texts))
            self.texts.extend(texts)
            if vecs is not None:
                self.vecs = vecs if self.vecs is None else np.vstack([self.vecs, vecs])

    def best(self, text: str, only: set[str] | None = None) -> tuple[str | None, float]:
        """(move id, score) of the closest name or alias; `only` limits it to some move ids."""
        q = clean(text)
        if not q:
            return None, 0.0
        with self.lock:
            if not self.ids:
                return None, 0.0
            rows = range(len(self.ids)) if only is None else [i for i, m in enumerate(self.ids) if m in only]
            if not rows:
                return None, 0.0
            if self.model is not None and self.vecs is not None:
                rows = list(rows)
                qv = self._embed([q])[0]
                sims = self.vecs[rows] @ qv
                # an exact name or alias inside the shout always wins
                for k, i in enumerate(rows):
                    if self.texts[i] and f" {self.texts[i]} " in f" {q} ":
                        sims[k] = max(sims[k], 0.99)
                k = int(sims.argmax())
                return self.ids[rows[k]], float(sims[k])
            best_i, best_s = -1, 0.0
            for i in rows:
                t = self.texts[i]
                s = 0.99 if f" {t} " in f" {q} " else difflib.SequenceMatcher(None, q, t).ratio()
                if s > best_s:
                    best_i, best_s = i, s
            return (self.ids[best_i], best_s) if best_i >= 0 else (None, 0.0)
