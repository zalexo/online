const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
const PROGRESS_STORAGE_KEY = "books-map:progress";
const PROGRESS_VERSION = 1;
const BRANCH_PALETTE = [
  { fill: "#3f8cff", border: "#8ec5ff" },
  { fill: "#06b6d4", border: "#67e8f9" },
  { fill: "#10b981", border: "#6ee7b7" },
  { fill: "#84cc16", border: "#bef264" },
  { fill: "#f59e0b", border: "#fcd34d" },
  { fill: "#f97316", border: "#fdba74" },
  { fill: "#ef4444", border: "#fca5a5" },
  { fill: "#ec4899", border: "#f9a8d4" },
  { fill: "#8b5cf6", border: "#c4b5fd" }
];

function hashString(value) {
  return Array.from(value).reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) >>> 0;
  }, 7);
}

function getBranchColors(branch) {
  const normalized = (branch || "unknown").trim().toLowerCase();
  const paletteItem = BRANCH_PALETTE[hashString(normalized) % BRANCH_PALETTE.length];

  return {
    fill: paletteItem.fill,
    border: paletteItem.border,
    edge: `${paletteItem.border}99`
  };
}

function setStatus(message) {
  const statusChip = document.getElementById("status-chip");
  if (statusChip) {
    statusChip.textContent = message;
  }
}

function getDefaultProgress() {
  return {
    read: [],
    reading: [],
    updatedAt: null,
    version: PROGRESS_VERSION
  };
}

function normalizeProgress(raw) {
  const fallback = getDefaultProgress();

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const read = Array.isArray(raw.read) ? raw.read.filter((item) => typeof item === "string") : [];
  const reading = Array.isArray(raw.reading)
    ? raw.reading.filter((item) => typeof item === "string")
    : [];

  return {
    read: [...new Set(read)],
    reading: [...new Set(reading)],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    version: PROGRESS_VERSION
  };
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) {
      return getDefaultProgress();
    }

    const parsed = JSON.parse(raw);
    const normalized = normalizeProgress(parsed);
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch (error) {
    const fallback = getDefaultProgress();
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
  }
}

function setOverlay(title, message) {
  const overlay = document.getElementById("empty-overlay");
  if (!overlay) {
    return;
  }

  overlay.innerHTML = `
    <strong>${title}</strong>
    <span>${message}</span>
  `;
}

function hideOverlay() {
  const overlay = document.getElementById("empty-overlay");
  if (overlay) {
    overlay.hidden = true;
  }
}

function renderLegend(branches) {
  const legend = document.getElementById("branch-legend");
  if (!legend) {
    return;
  }

  if (!branches.length) {
    legend.hidden = true;
    legend.innerHTML = "";
    return;
  }

  legend.innerHTML = branches
    .map((branch) => {
      const colors = getBranchColors(branch);
      return `
        <span class="legend-item">
          <span class="legend-swatch" style="background:${colors.fill}"></span>
          <span>${branch}</span>
        </span>
      `;
    })
    .join("");

  legend.hidden = false;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateNode(node) {
  const requiredFields = [
    "id",
    "title",
    "author",
    "branch",
    "requires",
    "content_html"
  ];

  for (const field of requiredFields) {
    if (!(field in node)) {
      throw new Error(`Node "${node.id || "unknown"}" misses "${field}"`);
    }
  }

  if (!Array.isArray(node.requires)) {
    throw new Error(`Node "${node.id}" must have "requires" as array`);
  }

  if ("unlock_mode" in node && node.unlock_mode !== "all" && node.unlock_mode !== "any") {
    throw new Error(`Node "${node.id}" must have unlock_mode "all" or "any"`);
  }

  const hasFixedPosition = isNumber(node.x) && isNumber(node.y);
  const hasDeclarativeLayout =
    typeof node.lane === "string" &&
    typeof node.level === "number" &&
    typeof node.order === "number";

  if (!hasFixedPosition && !hasDeclarativeLayout) {
    throw new Error(
      `Node "${node.id}" must define either x/y or lane/level/order`
    );
  }
}

function validateEdge(edge) {
  const requiredFields = ["id", "source", "target"];
  for (const field of requiredFields) {
    if (!(field in edge)) {
      throw new Error(`Edge misses "${field}"`);
    }
  }
}

function validateGraph(graph) {
  if (!graph || typeof graph !== "object") {
    throw new Error("graph.json must contain an object");
  }

  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('graph.json must contain "nodes" and "edges" arrays');
  }

  graph.nodes.forEach(validateNode);
  graph.edges.forEach(validateEdge);
}

function computeDeclarativePositions(rawNodes) {
  const laneNames = [...new Set(rawNodes.map((node) => node.lane).filter(Boolean))].sort();
  const laneIndexMap = new Map(laneNames.map((lane, index) => [lane, index]));
  const laneSpacing = 240;
  const levelSpacing = 280;
  const orderSpacing = 92;

  const positions = new Map();

  rawNodes.forEach((node) => {
    if (isNumber(node.x) && isNumber(node.y)) {
      positions.set(node.id, {
        x: node.x,
        y: node.y,
        fixed: true
      });
      return;
    }

    const laneIndex = laneIndexMap.get(node.lane) || 0;
    const level = Number(node.level) || 0;
    const order = Number(node.order) || 0;

    positions.set(node.id, {
      x: 160 + level * levelSpacing,
      y: 140 + laneIndex * laneSpacing + order * orderSpacing,
      fixed: false
    });
  });

  return positions;
}

function getNodeState(node, readSet) {
  const requires = Array.isArray(node.requires) ? node.requires : [];
  const unlockMode = node.unlock_mode === "any" ? "any" : "all";

  if (readSet.has(node.id)) {
    return "read";
  }

  if (requires.length === 0) {
    return "start";
  }

  const satisfiedCount = requires.filter((id) => readSet.has(id)).length;
  const isUnlocked = unlockMode === "any" ? satisfiedCount > 0 : satisfiedCount === requires.length;

  return isUnlocked ? "unlocked" : "locked";
}

function decorateNodeByState(node, state, colors) {
  const stateStyles = {
    start: {
      size: 22,
      borderWidth: 4,
      color: {
        background: colors.fill,
        border: "#ffffff"
      }
    },
    unlocked: {
      size: 19,
      borderWidth: 3,
      color: {
        background: colors.fill,
        border: colors.border
      }
    },
    read: {
      size: 21,
      borderWidth: 4,
      color: {
        background: colors.border,
        border: "#ffffff"
      }
    },
    locked: {
      size: 17,
      borderWidth: 2,
      color: {
        background: "rgba(53, 66, 85, 0.45)",
        border: "rgba(155, 171, 193, 0.5)"
      },
      font: {
        color: "#8ca0bb"
      }
    }
  };

  return {
    ...node,
    ...stateStyles[state],
    state
  };
}

function prepareNodes(rawNodes, progress) {
  const positions = computeDeclarativePositions(rawNodes);
  const readSet = new Set(progress.read);

  return rawNodes.map((node) => {
    const colors = getBranchColors(node.branch);
    const state = getNodeState(node, readSet);
    const visNode = {
      id: node.id,
      label: state === "read" ? `${node.title}\n✓` : node.title,
      title: `${node.title}\n${node.author}`,
      branch: node.branch,
      shape: "dot",
      size: 18,
      color: {
        background: colors.fill,
        border: colors.border,
        highlight: {
          background: colors.border,
          border: "#ffffff"
        },
        hover: {
          background: colors.border,
          border: "#ffffff"
        }
      },
      font: {
        color: "#f4f8ff",
        face: "Segoe UI",
        size: 16,
        strokeWidth: 0
      },
      unlockMode: node.unlock_mode === "any" ? "any" : "all",
      raw: node
    };

    const position = positions.get(node.id);
    visNode.x = position.x;
    visNode.y = position.y;
    visNode.fixed = {
      x: position.fixed,
      y: position.fixed
    };

    return decorateNodeByState(visNode, state, colors);
  });
}

function prepareEdges(rawEdges) {
  return rawEdges.map((edge) => ({
    id: edge.id,
    from: edge.source,
    to: edge.target,
    color: {
      color: getBranchColors(edge.color_theme || "").edge,
      highlight: "#ffffff",
      hover: "#ffffff"
    },
    arrows: {
      to: {
        enabled: true,
        scaleFactor: 0.9
      }
    },
    raw: edge
  }));
}

async function loadGraph() {
  const response = await fetch("./graph.json", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to load graph.json (${response.status})`);
  }

  const graph = await response.json();
  validateGraph(graph);
  const progress = loadProgress();

  return {
    raw: graph,
    progress,
    nodes: prepareNodes(graph.nodes, progress),
    edges: prepareEdges(graph.edges)
  };
}

function createOptions() {
  return {
    autoResize: true,
    nodes: {
      shape: "dot",
      size: 18,
      borderWidth: 2,
      borderWidthSelected: 3,
      margin: {
        top: 10,
        right: 14,
        bottom: 10,
        left: 14
      },
      widthConstraint: {
        maximum: 240
      },
      font: {
        color: "#eaf2ff",
        face: "Segoe UI",
        size: 16,
        multi: "html"
      },
      shadow: {
        enabled: true,
        color: "rgba(0, 0, 0, 0.28)",
        size: 16,
        x: 0,
        y: 10
      }
    },
    edges: {
      arrows: {
        to: {
          enabled: true,
          scaleFactor: 0.9
        }
      },
      color: {
        color: "rgba(125, 160, 210, 0.45)",
        highlight: "#7de0b6",
        hover: "#54c6eb"
      },
      smooth: {
        enabled: true,
        type: "dynamic",
        roundness: 0.28
      },
      width: 2.5,
      selectionWidth: 4,
      shadow: {
        enabled: true,
        color: "rgba(84, 198, 235, 0.14)",
        size: 10,
        x: 0,
        y: 0
      }
    },
    interaction: {
      dragNodes: true,
      dragView: true,
      hover: true,
      multiselect: false,
      navigationButtons: false,
      zoomView: true,
      tooltipDelay: 80
    },
    physics: {
      enabled: false,
      stabilization: {
        iterations: 120
      },
      barnesHut: {
        gravitationalConstant: -9000,
        springLength: 180,
        springConstant: 0.02,
        damping: 0.18
      }
    },
    layout: {
      improvedLayout: true
    },
    configure: {
      enabled: false
    }
  };
}

document.addEventListener("DOMContentLoaded", () => {
  const graphElement = document.getElementById("network-graph");

  if (!graphElement) {
    return;
  }

  if (!window.vis || typeof window.vis.Network !== "function") {
    setStatus("vis-network не загрузился");
    setOverlay(
      "Ошибка инициализации",
      "CDN-библиотека vis-network недоступна, поэтому карта не может запуститься."
    );
    return;
  }

  const network = new vis.Network(
    graphElement,
    { nodes, edges },
    createOptions()
  );

  setStatus("Загрузка graph.json...");

  loadGraph()
    .then((graph) => {
      const branches = [
        ...new Set(graph.raw.nodes.map((node) => node.branch).filter(Boolean))
      ].sort((a, b) => a.localeCompare(b, "ru"));

      nodes.clear();
      edges.clear();
      nodes.add(graph.nodes);
      edges.add(graph.edges);

      renderLegend(branches);
      hideOverlay();
      const readCount = graph.progress.read.length;
      setStatus(
        `Загружено: ${graph.nodes.length} книг, ${graph.edges.length} связей, read ${readCount}`
      );

      network.fit({
        animation: {
          duration: 450,
          easingFunction: "easeInOutQuad"
        }
      });
    })
    .catch((error) => {
      console.error("Books Map graph load failed:", error);
      setStatus("graph.json не загружен");
      setOverlay(
        "Данные пока недоступны",
        "Фронтенд уже готов, но файл graph.json ещё не собран или не прошёл проверку контракта."
      );
    });
});
