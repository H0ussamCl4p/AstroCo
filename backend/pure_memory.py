import json
import os
import re
from pathlib import Path

# Project root (parent of backend/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent

class MemoryManager:
    """
    A lightweight Long-Term Memory & Context Manager (Fact Archive) 
    inspired by local-first agent architectures.
    """
    def __init__(self, memory_file=None):
        if memory_file is None:
            memory_file = str(_PROJECT_ROOT / "data" / "astroco_memory.json")
        self.memory_file = memory_file
        self.facts = []
        self._load()

    def _load(self):
        if os.path.exists(self.memory_file):
            try:
                with open(self.memory_file, "r") as f:
                    self.facts = json.load(f)
            except Exception:
                self.facts = []

    def _save(self):
        with open(self.memory_file, "w") as f:
            json.dump(self.facts, f, indent=2)

    def _normalize_fact(self, fact: str) -> str:
        fact = (fact or "").strip()
        fact = re.sub(r"\s+", " ", fact)
        return fact

    def _should_save_fact(self, fact: str, *, source_user_text: str | None = None) -> bool:
        """Heuristic guardrail: only save stable user-specific preferences/identity.

        This prevents accidental saves like "Artemis II" or other non-user facts.
        """

        f = self._normalize_fact(fact)
        if not f:
            return False

        # Too short is almost always junk (e.g., "Blue", "Test").
        if len(f) < 10:
            return False

        fl = f.lower()

        # Must look like a user fact: first-person or explicit user reference.
        userish = any(
            k in fl
            for k in [
                "i ",
                "i'm",
                "im ",
                "my ",
                "me ",
                "mine",
                "user ",
                "user's",
                "my favorite",
                "i like",
                "i love",
                "i prefer",
            ]
        )
        if not userish:
            return False

        # Avoid saving "facts" that are clearly domain content unless framed as preference.
        domain_terms = ["artemis", "apollo", "nasa", "moon", "orion", "sls"]
        if any(t in fl for t in domain_terms) and not any(
            k in fl for k in ["i like", "i love", "i'm interested", "my favorite"]
        ):
            return False

        # If the user prompt is clearly about missions, be extra strict.
        if source_user_text:
            ul = source_user_text.lower()
            if any(t in ul for t in domain_terms) and not any(
                k in fl for k in ["my ", "i ", "i'm", "im ", "user "]
            ):
                return False

        return True

    def add_fact(self, fact: str, *, source_user_text: str | None = None) -> bool:
        fact = self._normalize_fact(fact)
        if not self._should_save_fact(fact, source_user_text=source_user_text):
            return False

        if fact not in self.facts:
            self.facts.append(fact)
            self._save()
            print(f"\n[Memory Bank] Saved new fact: {fact}")
        return True

    def get_context_string(self) -> str:
        if not self.facts:
            return "No previous memories about the user yet."
        return "Previously known facts about the user:\n" + "\n".join(f"- {f}" for f in self.facts)
