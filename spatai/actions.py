"""Actions of the semantic model."""

from __future__ import annotations

from spatai.model import INTERACTIVE_MEDIA, SmartDisplay


def launch_media(display: SmartDisplay, media: str = INTERACTIVE_MEDIA) -> SmartDisplay:
    """Launch_Media(): switch Display.Current_Media from the default loop to interactive content."""
    display.current_media = media
    return display
