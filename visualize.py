"""Draw the demo scene as a top-down floor plan and save it as scene.png.

Run from the repository root:  python3 visualize.py   (needs matplotlib)
"""

import math

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Circle as CirclePatch
from matplotlib.patches import Patch, Rectangle

from demo import build_scene
from spatai import PROXIMITY_THRESHOLD_M, Circle, Location, PowerState, Rect, evaluate_rules

OUTPUT = "scene.png"

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
MUTED = "#898781"
NEUTRAL_FILL = "#f0efec"
PLACE_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"]  # categorical slots 1-3, in order
STATUS_ON = "#0ca30c"
STATUS_OFF = MUTED
FRAME_COLOR = "#4a3aa7"


def world_xy(loc: Location) -> tuple[float, float]:
    w = loc.to_world()
    return w.x, w.y


def draw_region(ax, region, **style):
    if isinstance(region, Circle):
        x, y = world_xy(region.center)
        ax.add_patch(CirclePatch((x, y), region.radius, **style))
    elif isinstance(region, Rect):
        x, y = world_xy(Location(region.x_min, region.y_min, region.frame))
        ax.add_patch(
            Rectangle(
                (x, y),
                region.x_max - region.x_min,
                region.y_max - region.y_min,
                angle=region.frame.world_rotation(),
                **style,
            )
        )


def arrow(ax, start, dx, dy, color, width=0.06, head=0.35):
    ax.arrow(*start, dx, dy, width=width, head_width=head, head_length=head,
             length_includes_head=True, color=color, zorder=6)


def main() -> None:
    world, frames = build_scene()
    evaluate_rules(world)

    fig, ax = plt.subplots(figsize=(12, 8.2), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)

    # Places: the outer place is neutral, nested places take categorical slots in order.
    nested = [p for p in world.places.values() if p.parent is not None]
    for place in world.places.values():
        if place.parent is None:
            draw_region(ax, place.region, facecolor=NEUTRAL_FILL, edgecolor="none", zorder=1)
    for place, color in zip(nested, PLACE_COLORS):
        draw_region(ax, place.region, facecolor=color, alpha=0.22, edgecolor=color, lw=1.5, zorder=2)

    label = dict(color=INK, fontsize=10.5, fontweight="bold", zorder=8)
    ax.text(0.25, 0.35, "Main Lobby", ha="left", va="bottom", **label)
    ax.text(0.75, 6.0, "Entrance", ha="center", va="center", rotation=90, **label)
    ax.text(10, 1.2, "Reception Desk", ha="center", va="top", **label)
    ax.text(19.75, 7.25, "Gallery Corner", ha="right", va="bottom", **label)

    # Zone boundary.
    for zone in world.zones.values():
        draw_region(ax, zone.boundary, facecolor="none", edgecolor=INK, lw=2.5, zorder=3)
        b = zone.boundary
        ax.text(b.x_min, b.y_max + 0.25, f"zone '{zone.zone_id}'  ({b.x_max - b.x_min:g} m × {b.y_max - b.y_min:g} m)",
                color=INK_SECONDARY, fontsize=10, ha="left", va="bottom")

    # Displays: marker, facing arrow, 2.5 m power-on radius, coloured by state.
    for display in world.displays.values():
        on = display.power_state is PowerState.ON
        color = STATUS_ON if on else STATUS_OFF
        x, y = world_xy(display.position)
        ax.add_patch(CirclePatch((x, y), PROXIMITY_THRESHOLD_M, facecolor=color, alpha=0.10,
                                 edgecolor=color, lw=1.5, ls="--", zorder=4))
        heading = math.radians(display.world_orientation())
        arrow(ax, (x, y), 1.6 * math.cos(heading), 1.6 * math.sin(heading), color, width=0.09, head=0.45)
        ax.plot(x, y, marker="s", ms=13, color=color, mec=SURFACE, mew=2, zorder=7)
        # Label on the side away from the facing arrow and nearby visitors.
        if display.display_id == "welcome-screen":
            tx, ty, ha, va = x + 0.2, y - 0.55, "left", "top"
        else:
            tx, ty, ha, va = x - 0.55, y, "right", "center"
        ax.text(tx, ty, f"{display.display_id}\n{display.power_state.value}",
                ha=ha, va=va, fontsize=9.5, color=INK, zorder=8)

    # Gallery-screen's reference frame: x' = ahead, y' = left.
    frame = frames["gallery-screen"]
    origin = frame.to_world(0, 0)
    for (fx, fy), name in [((4.2, 0), "x′ (ahead)"), ((0, 4.2), "y′ (left)")]:
        ex, ey = frame.to_world(fx, fy)
        arrow(ax, origin, ex - origin[0], ey - origin[1], FRAME_COLOR, width=0.035, head=0.3)
        ax.text(ex + (0.15 if fy else 0), ey - (0.15 if fx else -0.15), name, color=FRAME_COLOR,
                fontsize=9.5, ha="left" if fy else "center", va="top" if fx else "bottom", zorder=8)

    # Bob decomposed in that frame: 3 m along x', then 2 m along -y' (to the right).
    bob = world.position_in("bob", frame)
    corner = frame.to_world(bob.x, 0)
    bob_xy = world_xy(world.locate("bob"))
    ax.plot([origin[0], corner[0]], [origin[1], corner[1]], color=FRAME_COLOR, lw=2.5, zorder=5)
    ax.plot([corner[0], bob_xy[0]], [corner[1], bob_xy[1]], color=FRAME_COLOR, lw=2.5, ls=(0, (3, 2)), zorder=5)
    ax.text(origin[0] + 0.2, corner[1] + 0.8, f"{bob.x:g} m ahead", color=FRAME_COLOR,
            fontsize=9.5, ha="left", va="center", zorder=8)
    ax.text((corner[0] + bob_xy[0]) / 2, corner[1] - 0.2, f"{abs(bob.y):g} m right", color=FRAME_COLOR,
            fontsize=9.5, ha="center", va="top", zorder=8)

    # Visitors.
    for visitor in world.visitors.values():
        x, y = world_xy(visitor.position)
        ax.plot(x, y, "o", ms=10, color=INK, mec=SURFACE, mew=2, zorder=9)
        dx, ha = (-0.3, "right") if visitor.user_id == "bob" else (0.3, "left")
        ax.text(x + dx, y + 0.1, visitor.user_id, ha=ha, va="bottom", fontsize=10, color=INK, zorder=9)

    legend = [
        Line2D([], [], marker="s", ls="none", ms=11, color=STATUS_ON, label="display ON  (dashed ring = 2.5 m)"),
        Line2D([], [], marker="s", ls="none", ms=11, color=STATUS_OFF, label="display OFF"),
        Line2D([], [], marker="o", ls="none", ms=9, color=INK, label="visitor"),
        Line2D([], [], color=FRAME_COLOR, lw=2, label="gallery-screen frame and bob's offset"),
        Patch(facecolor="none", edgecolor=INK, lw=2, label="zone boundary"),
    ]
    ax.legend(handles=legend, loc="upper left", bbox_to_anchor=(0, -0.08), ncol=3, frameon=False,
              fontsize=9.5, labelcolor=INK_SECONDARY)

    ax.set_xlim(-1, 21)
    ax.set_ylim(-0.8, 14)
    ax.set_aspect("equal")
    ax.set_xticks(range(0, 21, 2))
    ax.set_yticks(range(0, 13, 2))
    ax.tick_params(colors=MUTED, labelsize=9, length=0)
    ax.grid(color="#e1e0d9", lw=0.6, zorder=0)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_xlabel("x (m, world frame)", color=MUTED, fontsize=9)
    ax.set_ylabel("y (m, world frame)", color=MUTED, fontsize=9)
    ax.set_title("SPATAI demo scene: top-down floor plan", color=INK, fontsize=14, loc="left", pad=12)

    fig.tight_layout()
    fig.savefig(OUTPUT, dpi=150, facecolor=SURFACE)
    print(f"Saved {OUTPUT}")


if __name__ == "__main__":
    main()
