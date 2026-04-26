const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
const PROGRESS_STORAGE_KEY = "books-map:progress";
const PROGRESS_VERSION = 1;
const BRANCH_PALETTE = [
  { fill: "#2f9e83", border: "#7af0cc" },
  { fill: "#d4952f", border: "#ffd985" },
  { fill: "#d95d4f", border: "#ffad9f" },
  { fill: "#4b9fbd", border: "#9ee8ff" },
  { fill: "#6ca342", border: "#bdec80" },
  { fill: "#c05f92", border: "#ffb0d6" },
  { fill: "#a9864b", border: "#edcf8f" },
  { fill: "#5d82c4", border: "#b4ccff" }
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

function normalizeBridgeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  // YAML folded scalars may leak ">-" into runtime text.
  const cleaned = value.replace(/\s*>\-\s*/g, " ").replace(/\s+/g, " ").trim();
  return cleaned;
}

function getRelevantIncomingEdge(edgesList, targetNodeId, progress) {
  const incomingEdges = Array.isArray(edgesList)
    ? edgesList.filter((edge) => edge && edge.target === targetNodeId)
    : [];

  if (!incomingEdges.length) {
    return null;
  }

  const readIds = Array.isArray(progress?.read) ? progress.read : [];
  const readOrder = new Map(readIds.map((id, index) => [id, index]));
  const readLinkedEdges = incomingEdges
    .filter((edge) => readOrder.has(edge.source))
    .sort((left, right) => readOrder.get(right.source) - readOrder.get(left.source));

  if (readLinkedEdges.length) {
    return readLinkedEdges[0];
  }

  const withBridgeText = incomingEdges.find((edge) => normalizeBridgeText(edge.bridge_text));
  return withBridgeText || incomingEdges[0];
}

function getDefaultProgress() {
  return {
    read: [],
    reading: [],
    updatedAt: null,
    version: PROGRESS_VERSION
  };
}

function sanitizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item) => typeof item === "string"))];
}

function normalizeProgress(raw) {
  const fallback = getDefaultProgress();

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  if (raw.version !== PROGRESS_VERSION) {
    return fallback;
  }

  const read = sanitizeStringList(raw.read);
  const reading = sanitizeStringList(raw.reading).filter((id) => !read.includes(id));
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;

  return {
    read,
    reading,
    updatedAt,
    version: PROGRESS_VERSION
  };
}

function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch (error) {
    console.warn("Unable to persist books progress:", error);
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) {
      return getDefaultProgress();
    }

    const parsed = JSON.parse(raw);
    const normalized = normalizeProgress(parsed);
    saveProgress(normalized);
    return normalized;
  } catch (error) {
    const fallback = getDefaultProgress();
    saveProgress(fallback);
    return fallback;
  }
}

function getBookProgressStatus(bookId, progress) {
  if (!bookId || !progress) {
    return null;
  }

  if (Array.isArray(progress.read) && progress.read.includes(bookId)) {
    return "read";
  }

  if (Array.isArray(progress.reading) && progress.reading.includes(bookId)) {
    return "reading";
  }

  return null;
}

function toggleBookProgressStatus(progress, bookId, targetStatus) {
  if (!bookId || (targetStatus !== "read" && targetStatus !== "reading")) {
    return progress;
  }

  const readSet = new Set(progress.read);
  const readingSet = new Set(progress.reading);
  const currentStatus = getBookProgressStatus(bookId, progress);

  if (targetStatus === "read") {
    if (currentStatus === "read") {
      readSet.delete(bookId);
    } else {
      readSet.add(bookId);
      readingSet.delete(bookId);
    }
  } else if (currentStatus === "reading") {
    readingSet.delete(bookId);
  } else {
    readingSet.add(bookId);
    readSet.delete(bookId);
  }

  const nextRead = [...readSet];
  const nextReading = [...readingSet].filter((id) => !readSet.has(id));
  const didChange =
    nextRead.length !== progress.read.length ||
    nextReading.length !== progress.reading.length ||
    nextRead.some((id) => !progress.read.includes(id)) ||
    nextReading.some((id) => !progress.reading.includes(id));

  if (!didChange) {
    return progress;
  }

  return {
    read: nextRead,
    reading: nextReading,
    updatedAt: new Date().toISOString(),
    version: PROGRESS_VERSION
  };
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

function buildNodeStateMap(rawNodes, progress) {
  const readSet = new Set(progress.read);
  const readingSet = new Set(progress.reading);
  const stateMap = new Map();

  rawNodes.forEach((node) => {
    stateMap.set(node.id, getNodeState(node, readSet, readingSet));
  });

  return stateMap;
}

function createDrawerController({ getBookStatus, onBookStatusToggle } = {}) {
  const drawer = document.getElementById("book-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  const closeButton = document.getElementById("book-drawer-close");
  const drawerTitle = document.getElementById("book-drawer-title");
  const drawerAuthor = document.getElementById("book-drawer-author");
  const drawerBranch = document.getElementById("book-drawer-branch");
  const drawerContent = document.getElementById("book-drawer-content");
  const drawerBridge = document.getElementById("book-drawer-bridge");
  const statusReadingButton = document.getElementById("book-status-reading");
  const statusReadButton = document.getElementById("book-status-read");
  const statusButtons = [statusReadingButton, statusReadButton].filter(Boolean);
  let selectedBookId = null;

  if (!drawer || !backdrop || !closeButton || !drawerTitle || !drawerAuthor || !drawerBranch || !drawerContent) {
    return {
      open() {},
      close() {}
    };
  }

  const setStatusButtonsState = (activeStatus) => {
    statusButtons.forEach((button) => {
      const isActive = button.dataset.status === activeStatus;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  };

  const open = (payload = {}) => {
    const title = typeof payload.title === "string" ? payload.title : "Карточка книги";
    const author = typeof payload.author === "string" ? payload.author : "Автор будет добавлен на следующем шаге";
    const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
    const contentHtml =
      typeof payload.contentHtml === "string"
        ? payload.contentHtml
        : "<p>Выберите узел на карте, чтобы открыть карточку книги.</p>";
    selectedBookId = typeof payload.nodeId === "string" ? payload.nodeId : null;
    const activeStatus =
      selectedBookId && typeof getBookStatus === "function"
        ? getBookStatus(selectedBookId)
        : null;

    drawerTitle.textContent = title;
    drawerAuthor.textContent = author;
    drawerContent.innerHTML = contentHtml;
    setStatusButtonsState(activeStatus);

    if (drawerBridge) {
      const bridgeText = normalizeBridgeText(payload.bridgeText);
      if (bridgeText) {
        drawerBridge.textContent = `Переход от предыдущей книги: ${bridgeText}`;
        drawerBridge.hidden = false;
      } else {
        drawerBridge.textContent = "";
        drawerBridge.hidden = true;
      }
    }

    if (branch) {
      drawerBranch.hidden = false;
      drawerBranch.textContent = branch;
      const colors = getBranchColors(branch);
      drawerBranch.style.borderColor = `${colors.border}80`;
      drawerBranch.style.background = `${colors.fill}24`;
      drawerBranch.style.color = "#eaf2ff";
    } else {
      drawerBranch.hidden = true;
      drawerBranch.textContent = "";
      drawerBranch.removeAttribute("style");
    }

    backdrop.hidden = false;
    drawer.hidden = false;
    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
      drawer.classList.add("is-open");
    });

    drawer.setAttribute("aria-hidden", "false");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
  };

  const close = () => {
    selectedBookId = null;
    backdrop.classList.remove("is-open");
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    backdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("drawer-open");

    window.setTimeout(() => {
      if (!drawer.classList.contains("is-open")) {
        drawer.hidden = true;
      }
      if (!backdrop.classList.contains("is-open")) {
        backdrop.hidden = true;
      }
    }, 260);
  };

  statusButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!selectedBookId || typeof onBookStatusToggle !== "function") {
        return;
      }

      const status = button.dataset.status;
      const nextStatus = onBookStatusToggle(selectedBookId, status);
      setStatusButtonsState(nextStatus);
    });
  });

  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer.classList.contains("is-open")) {
      close();
    }
  });

  return { open, close };
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

function getNodeState(node, readSet, readingSet) {
  const requires = Array.isArray(node.requires) ? node.requires : [];
  const unlockMode = node.unlock_mode === "any" ? "any" : "all";

  if (readSet.has(node.id)) {
    return "read";
  }

  if (readingSet.has(node.id)) {
    return "reading";
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
      size: 25,
      borderWidth: 5,
      color: {
        background: colors.fill,
        border: "#fff7df"
      }
    },
    unlocked: {
      size: 22,
      borderWidth: 3,
      color: {
        background: colors.fill,
        border: colors.border
      }
    },
    read: {
      size: 24,
      borderWidth: 4,
      color: {
        background: colors.border,
        border: "#fff7df"
      }
    },
    reading: {
      size: 23,
      borderWidth: 3,
      color: {
        background: `${colors.fill}bb`,
        border: "#fff0bd"
      }
    },
    locked: {
      size: 18,
      borderWidth: 2,
      color: {
        background: "rgba(57, 66, 62, 0.48)",
        border: "rgba(176, 188, 178, 0.42)"
      },
      font: {
        color: "#89968b"
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
  const stateMap = buildNodeStateMap(rawNodes, progress);

  return rawNodes.map((node) => {
    const colors = getBranchColors(node.branch);
    const state = stateMap.get(node.id);
    const visNode = {
      id: node.id,
      label: state === "read" ? `${node.title}\nread` : state === "reading" ? `${node.title}\nreading` : node.title,
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
        color: "#f1f5ed",
        face: "IBM Plex Sans",
        size: 16,
        strokeWidth: 5,
        strokeColor: "rgba(8, 12, 12, 0.9)"
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

function prepareEdges(rawEdges, stateMap = new Map()) {
  return rawEdges.map((edge) => {
    const sourceState = stateMap.get(edge.source);
    const targetState = stateMap.get(edge.target);
    const isActivated = sourceState === "read" || targetState === "read" || targetState === "reading";
    const isLocked = targetState === "locked";
    const colors = getBranchColors(edge.color_theme || "");

    return {
      id: edge.id,
      from: edge.source,
      to: edge.target,
      width: isActivated ? 4 : 2,
      dashes: isLocked ? [8, 10] : false,
      color: {
        color: isLocked ? "rgba(150, 160, 150, 0.22)" : colors.edge,
        highlight: "#fff7df",
        hover: colors.border
      },
      arrows: {
        to: {
          enabled: true,
          scaleFactor: isActivated ? 1 : 0.78
        }
      },
      shadow: {
        enabled: isActivated,
        color: `${colors.border}66`,
        size: 16,
        x: 0,
        y: 0
      },
      raw: edge
    };
  });
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
  const stateMap = buildNodeStateMap(graph.nodes, progress);

  return {
    raw: graph,
    progress,
    nodes: prepareNodes(graph.nodes, progress),
    edges: prepareEdges(graph.edges, stateMap)
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
        color: "#f1f5ed",
        face: "IBM Plex Sans",
        size: 16,
        multi: "html",
        strokeWidth: 5,
        strokeColor: "rgba(8, 12, 12, 0.9)"
      },
      shadow: {
        enabled: true,
        color: "rgba(61, 214, 179, 0.2)",
        size: 22,
        x: 0,
        y: 0
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
        color: "rgba(178, 196, 181, 0.34)",
        highlight: "#fff7df",
        hover: "#3dd6b3"
      },
      smooth: {
        enabled: true,
        type: "cubicBezier",
        forceDirection: "horizontal",
        roundness: 0.34
      },
      width: 2.5,
      selectionWidth: 4,
      shadow: {
        enabled: true,
        color: "rgba(61, 214, 179, 0.16)",
        size: 14,
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

function buildStatusChipMessage(totalNodes, progress) {
  const readCount = Array.isArray(progress?.read) ? progress.read.length : 0;
  const readingCount = Array.isArray(progress?.reading) ? progress.reading.length : 0;
  return `Книг: ${totalNodes}, прочитал: ${readCount}, читаю: ${readingCount}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const graphElement = document.getElementById("network-graph");
  let currentGraph = null;
  let currentProgress = getDefaultProgress();
  const drawerController = createDrawerController({
    getBookStatus: (bookId) => getBookProgressStatus(bookId, currentProgress),
    onBookStatusToggle: (bookId, status) => {
      if (!currentGraph) {
        return getBookProgressStatus(bookId, currentProgress);
      }

      const nextProgress = toggleBookProgressStatus(currentProgress, bookId, status);
      if (nextProgress === currentProgress) {
        return getBookProgressStatus(bookId, currentProgress);
      }

      currentProgress = nextProgress;
      saveProgress(currentProgress);
      const nextNodes = prepareNodes(currentGraph.raw.nodes, currentProgress);
      const nextStateMap = buildNodeStateMap(currentGraph.raw.nodes, currentProgress);
      const nextEdges = prepareEdges(currentGraph.raw.edges, nextStateMap);
      nodes.update(nextNodes);
      edges.update(nextEdges);
      setStatus(buildStatusChipMessage(currentGraph.raw.nodes.length, currentProgress));
      return getBookProgressStatus(bookId, currentProgress);
    }
  });

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
      currentGraph = graph;
      currentProgress = graph.progress;
      const branches = [
        ...new Set(graph.raw.nodes.map((node) => node.branch).filter(Boolean))
      ].sort((a, b) => a.localeCompare(b, "ru"));

      nodes.clear();
      edges.clear();
      nodes.add(graph.nodes);
      edges.add(graph.edges);

      renderLegend(branches);
      hideOverlay();
      setStatus(buildStatusChipMessage(graph.nodes.length, currentProgress));

      network.fit({
        animation: {
          duration: 450,
          easingFunction: "easeInOutQuad"
        }
      });

      network.on("click", (params) => {
        if (!params.nodes.length) {
          return;
        }

        const nodeId = params.nodes[0];
        const selectedNode = nodes.get(nodeId);
        if (!selectedNode || !selectedNode.raw) {
          return;
        }

        const incomingEdge = getRelevantIncomingEdge(graph.raw.edges, nodeId, currentProgress);
        const bridgeText = incomingEdge?.bridge_text || "";

        drawerController.open({
          nodeId: selectedNode.raw.id,
          title: selectedNode.raw.title,
          author: selectedNode.raw.author,
          branch: selectedNode.raw.branch,
          contentHtml: selectedNode.raw.content_html,
          bridgeText: bridgeText
        });
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
