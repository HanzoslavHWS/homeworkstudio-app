"use client";

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type ProjectType = "typovy" | "individualni";
type Currency = "CZK" | "EUR";
type RotationMode = "free" | "step90" | "locked";

type Fair = {
  id: string;
  name: string;
  priceList: string;
  defaultCurrency: Currency;
  logo: string;
};

type BoothVariant = {
  id: string;
  name: string;
};

type BoothType = {
  id: string;
  code: string;
  name: string;
  description: string;

  size: string;
  area: string;

  widthMm: number | null;
  depthMm: number | null;

  configReady: boolean;

  variants: BoothVariant[];
};

type PlacedComponent = {
  id: string;
  type: string;
  name: string;

  widthMm: number;
  depthMm: number;

  xMm: number;
  yMm: number;

  rotationDeg: number;
  rotationMode: RotationMode;
};

type Point = {
  x: number;
  y: number;
};

type CollisionRect = {
  id: string;

  x: number;
  y: number;

  width: number;
  height: number;
};

/* ================================================= */
/* VELETRHY                                          */
/* ================================================= */

const fairs: Fair[] = [
  {
    id: "for-beauty-autumn-2026",
    name: "FOR BEAUTY podzim 2026",
    priceList: "FOR BEAUTY podzim 2026",
    defaultCurrency: "CZK",
    logo: "/fairs/for-beauty.png",
  },

  {
    id: "for-decor-2026",
    name: "FOR DECOR 2026",
    priceList: "FOR DECOR 2026",
    defaultCurrency: "CZK",
    logo: "/fairs/for-decor.png",
  },

  {
    id: "international-2026",
    name: "Zahraniční veletrh 2026",
    priceList: "INTERNATIONAL 2026",
    defaultCurrency: "EUR",
    logo: "/fairs/international.png",
  },
];

/* ================================================= */
/* TYPOVÉ STÁNKY                                     */
/* ================================================= */

const boothTypes: BoothType[] = [
  {
    id: "koje-2x2",
    code: "K2",
    name: "Koje 2 × 2 m",
    description: "Základní otevřená veletržní koje.",

    size: "2 × 2 m",
    area: "4 m²",

    widthMm: 2000,
    depthMm: 2000,

    configReady: true,

    variants: [],
  },

  {
    id: "koje-3x2",
    code: "K3",
    name: "Koje 3 × 2 m",
    description: "Základní otevřená veletržní koje.",

    size: "3 × 2 m",
    area: "6 m²",

    widthMm: null,
    depthMm: null,

    configReady: false,

    variants: [],
  },

  {
    id: "t4",
    code: "T4",
    name: "Typový stánek T4",
    description: "Typová konstrukce T4 se čtyřmi variantami.",

    size: "T4",
    area: "—",

    widthMm: null,
    depthMm: null,

    configReady: false,

    variants: [
      {
        id: "t4-v1",
        name: "Varianta 1",
      },
      {
        id: "t4-v2",
        name: "Varianta 2",
      },
      {
        id: "t4-v3",
        name: "Varianta 3",
      },
      {
        id: "t4-v4",
        name: "Varianta 4",
      },
    ],
  },

  {
    id: "t6",
    code: "T6",
    name: "Typový stánek T6",
    description: "Typová konstrukce T6 se čtyřmi variantami.",

    size: "T6",
    area: "—",

    widthMm: null,
    depthMm: null,

    configReady: false,

    variants: [
      {
        id: "t6-v1",
        name: "Varianta 1",
      },
      {
        id: "t6-v2",
        name: "Varianta 2",
      },
      {
        id: "t6-v3",
        name: "Varianta 3",
      },
      {
        id: "t6-v4",
        name: "Varianta 4",
      },
    ],
  },
];

/* ================================================= */
/* KOLIZNÍ GEOMETRIE KOJE 2 × 2                     */
/* ================================================= */

/*
  Souřadnice půdorysu:

  0,0 ------------------------ 2000
   |  zadní stěna 80 mm
   |
   |  bok 1000 mm
   |
   |
  2000

  Zadní stěna:
  2000 × 80 mm

  Levý bok:
  80 × 1000 mm

  Pravý bok:
  80 × 1000 mm
*/

const koje2x2CollisionWalls: CollisionRect[] = [
  {
    id: "back-wall",
    x: 0,
    y: 0,
    width: 2000,
    height: 80,
  },

  {
    id: "left-wall",
    x: 0,
    y: 0,
    width: 80,
    height: 1000,
  },

  {
    id: "right-wall",
    x: 1920,
    y: 0,
    width: 80,
    height: 1000,
  },
];

/* ================================================= */
/* GEOMETRICKÉ FUNKCE                                */
/* ================================================= */

function degToRad(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function normalizeAngle(angle: number) {
  let normalized = angle % 360;

  if (normalized < 0) {
    normalized += 360;
  }

  return Math.round(normalized);
}

function getRotatedCorners(
  centerX: number,
  centerY: number,
  width: number,
  depth: number,
  rotationDeg: number
): Point[] {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;

  const radians = degToRad(rotationDeg);

  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const localCorners = [
    {
      x: -halfWidth,
      y: -halfDepth,
    },
    {
      x: halfWidth,
      y: -halfDepth,
    },
    {
      x: halfWidth,
      y: halfDepth,
    },
    {
      x: -halfWidth,
      y: halfDepth,
    },
  ];

  return localCorners.map((point) => ({
    x:
      centerX +
      point.x * cos -
      point.y * sin,

    y:
      centerY +
      point.x * sin +
      point.y * cos,
  }));
}

function rectToPoints(rect: CollisionRect): Point[] {
  return [
    {
      x: rect.x,
      y: rect.y,
    },
    {
      x: rect.x + rect.width,
      y: rect.y,
    },
    {
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    },
    {
      x: rect.x,
      y: rect.y + rect.height,
    },
  ];
}

function getAxes(points: Point[]) {
  const axes: Point[] = [];

  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];

    const edgeX = next.x - current.x;
    const edgeY = next.y - current.y;

    const normalX = -edgeY;
    const normalY = edgeX;

    const length = Math.sqrt(
      normalX * normalX +
        normalY * normalY
    );

    if (length === 0) {
      continue;
    }

    axes.push({
      x: normalX / length,
      y: normalY / length,
    });
  }

  return axes;
}

function projectPoints(
  points: Point[],
  axis: Point
) {
  let min =
    points[0].x * axis.x +
    points[0].y * axis.y;

  let max = min;

  for (let index = 1; index < points.length; index++) {
    const projection =
      points[index].x * axis.x +
      points[index].y * axis.y;

    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }

  return {
    min,
    max,
  };
}

function polygonsOverlap(
  polygonA: Point[],
  polygonB: Point[]
) {
  const axes = [
    ...getAxes(polygonA),
    ...getAxes(polygonB),
  ];

  const epsilon = 0.01;

  for (const axis of axes) {
    const projectionA =
      projectPoints(
        polygonA,
        axis
      );

    const projectionB =
      projectPoints(
        polygonB,
        axis
      );

    /*
      <= znamená:
      objekt se může přesně dotknout stěny,
      ale nesmí jí projít.
    */

    if (
      projectionA.max <=
        projectionB.min + epsilon ||
      projectionB.max <=
        projectionA.min + epsilon
    ) {
      return false;
    }
  }

  return true;
}

function getBounds(points: Point[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/* ================================================= */
/* APP                                               */
/* ================================================= */

export default function Home() {
  const canvasRef =
    useRef<HTMLDivElement | null>(null);

  const [step, setStep] =
    useState(1);

  const [type, setType] =
    useState<ProjectType>("typovy");

  const [fairId, setFairId] =
    useState("");

  const [company, setCompany] =
    useState("");

  const [contact, setContact] =
    useState("");

  const [currency, setCurrency] =
    useState<Currency>("CZK");

  const [
    selectedBoothId,
    setSelectedBoothId,
  ] = useState("");

  const [
    selectedVariantId,
    setSelectedVariantId,
  ] = useState("");

  const [
    placedComponents,
    setPlacedComponents,
  ] = useState<PlacedComponent[]>([]);

  const [
    selectedComponentId,
    setSelectedComponentId,
  ] = useState<string | null>(null);

  const [
    draggingComponentId,
    setDraggingComponentId,
  ] = useState<string | null>(null);

  const [
    editorMessage,
    setEditorMessage,
  ] = useState("");

  /* ================================================= */
  /* DERIVED                                          */
  /* ================================================= */

  const selectedFair =
    fairs.find(
      (fair) =>
        fair.id === fairId
    );

  const selectedBooth =
    boothTypes.find(
      (booth) =>
        booth.id ===
        selectedBoothId
    );

  const selectedVariant =
    selectedBooth?.variants.find(
      (variant) =>
        variant.id ===
        selectedVariantId
    );

  const selectedPlacedComponent =
    placedComponents.find(
      (component) =>
        component.id ===
        selectedComponentId
    );

  const canOpenConfigurator =
    Boolean(
      selectedBooth &&
        selectedBooth.configReady &&
        (
          selectedBooth.variants.length ===
            0 ||
          selectedVariantId !== ""
        )
    );

  /* ================================================= */
  /* PROJECT                                          */
  /* ================================================= */

  function handleFairChange(
    id: string
  ) {
    setFairId(id);

    const fair =
      fairs.find(
        (item) =>
          item.id === id
      );

    if (fair) {
      setCurrency(
        fair.defaultCurrency
      );
    } else {
      setCurrency("CZK");
    }
  }

  function handleBoothSelect(
    boothId: string
  ) {
    setSelectedBoothId(
      boothId
    );

    setSelectedVariantId("");

    setPlacedComponents([]);
    setSelectedComponentId(null);

    setEditorMessage("");
  }

  function startNewProject() {
    setStep(1);

    setType("typovy");

    setFairId("");
    setCompany("");
    setContact("");

    setCurrency("CZK");

    setSelectedBoothId("");
    setSelectedVariantId("");

    setPlacedComponents([]);
    setSelectedComponentId(null);

    setDraggingComponentId(null);

    setEditorMessage("");
  }

  /* ================================================= */
  /* COLLISION                                        */
  /* ================================================= */

  function getCollisionWalls() {
    if (
      selectedBooth?.id ===
      "koje-2x2"
    ) {
      return koje2x2CollisionWalls;
    }

    return [];
  }

  function isPositionValid(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    if (
      !selectedBooth?.widthMm ||
      !selectedBooth.depthMm
    ) {
      return false;
    }

    const corners =
      getRotatedCorners(
        centerX,
        centerY,

        component.widthMm,
        component.depthMm,

        rotationDeg
      );

    /*
      Hranice koberce / plochy.
    */

    const insideBooth =
      corners.every(
        (point) =>
          point.x >= 0 &&
          point.x <=
            selectedBooth.widthMm! &&
          point.y >= 0 &&
          point.y <=
            selectedBooth.depthMm!
      );

    if (!insideBooth) {
      return false;
    }

    /*
      Tvrdá kolize s konstrukcí.
    */

    const collisionWalls =
      getCollisionWalls();

    for (const wall of collisionWalls) {
      const wallPolygon =
        rectToPoints(wall);

      if (
        polygonsOverlap(
          corners,
          wallPolygon
        )
      ) {
        return false;
      }
    }

    return true;
  }

  /* ================================================= */
  /* SNAP                                             */
  /* ================================================= */

  function applySnap(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    if (
      !selectedBooth?.widthMm ||
      !selectedBooth.depthMm
    ) {
      return {
        x: centerX,
        y: centerY,
      };
    }

    let x = centerX;
    let y = centerY;

    const snapDistance = 40;

    function currentBounds() {
      return getBounds(
        getRotatedCorners(
          x,
          y,

          component.widthMm,
          component.depthMm,

          rotationDeg
        )
      );
    }

    let bounds =
      currentBounds();

    /*
      KOJE 2 × 2
      SNAP NA VNITŘNÍ HRANY KONSTRUKCE
    */

    if (
      selectedBooth.id ===
      "koje-2x2"
    ) {
      /*
        Zadní stěna končí na Y = 80.
      */

      if (
        y >= 40 &&
        bounds.minY <
          80 + snapDistance
      ) {
        y +=
          80 -
          bounds.minY;

        bounds =
          currentBounds();
      }

      /*
        Levý bok končí na X = 80,
        pouze v horní polovině stánku.
      */

      const overlapsLeftWallDepth =
        bounds.maxY > 0 &&
        bounds.minY < 1000;

      if (
        overlapsLeftWallDepth &&
        x >= 40 &&
        bounds.minX <
          80 + snapDistance
      ) {
        x +=
          80 -
          bounds.minX;

        bounds =
          currentBounds();
      }

      /*
        Pravý bok začíná na X = 1920.
      */

      const overlapsRightWallDepth =
        bounds.maxY > 0 &&
        bounds.minY < 1000;

      if (
        overlapsRightWallDepth &&
        x <= 1960 &&
        bounds.maxX >
          1920 -
            snapDistance
      ) {
        x +=
          1920 -
          bounds.maxX;

        bounds =
          currentBounds();
      }
    }

    /*
      SNAP NA HRANU PLOCHY.
    */

    if (
      Math.abs(
        bounds.minX
      ) <= snapDistance
    ) {
      x -= bounds.minX;

      bounds =
        currentBounds();
    }

    if (
      Math.abs(
        selectedBooth.widthMm -
          bounds.maxX
      ) <= snapDistance
    ) {
      x +=
        selectedBooth.widthMm -
        bounds.maxX;

      bounds =
        currentBounds();
    }

    if (
      Math.abs(
        selectedBooth.depthMm -
          bounds.maxY
      ) <= snapDistance
    ) {
      y +=
        selectedBooth.depthMm -
        bounds.maxY;
    }

    return {
      x,
      y,
    };
  }

  /* ================================================= */
  /* ADD COMPONENTS                                   */
  /* ================================================= */

  function addCabinet() {
    const cabinet: PlacedComponent = {
      id:
        "cabinet-" +
        Date.now(),

      type: "cabinet",
      name: "Testovací skříňka",

      widthMm: 800,
      depthMm: 400,

      xMm: 1000,
      yMm: 1350,

      rotationDeg: 0,

      rotationMode:
        "step90",
    };

    setPlacedComponents(
      (items) => [
        ...items,
        cabinet,
      ]
    );

    setSelectedComponentId(
      cabinet.id
    );

    setEditorMessage("");
  }

  function addChair() {
    const chair: PlacedComponent = {
      id:
        "chair-" +
        Date.now(),

      type: "chair",
      name: "Testovací židle",

      widthMm: 450,
      depthMm: 500,

      xMm: 1000,
      yMm: 1500,

      rotationDeg: 0,

      rotationMode:
        "free",
    };

    setPlacedComponents(
      (items) => [
        ...items,
        chair,
      ]
    );

    setSelectedComponentId(
      chair.id
    );

    setEditorMessage("");
  }

  /* ================================================= */
  /* MOVE                                             */
  /* ================================================= */

  function handleComponentPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    event.stopPropagation();

    setSelectedComponentId(
      componentId
    );

    setDraggingComponentId(
      componentId
    );

    setEditorMessage("");

    event.currentTarget.setPointerCapture(
      event.pointerId
    );
  }

  function handleComponentPointerMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    if (
      draggingComponentId !==
        componentId ||
      !canvasRef.current ||
      !selectedBooth?.widthMm ||
      !selectedBooth.depthMm
    ) {
      return;
    }

    const component =
      placedComponents.find(
        (item) =>
          item.id ===
          componentId
      );

    if (!component) {
      return;
    }

    const rect =
      canvasRef.current.getBoundingClientRect();

    const pointerX =
      (
        (
          event.clientX -
          rect.left
        ) /
        rect.width
      ) *
      selectedBooth.widthMm;

    const pointerY =
      (
        (
          event.clientY -
          rect.top
        ) /
        rect.height
      ) *
      selectedBooth.depthMm;

    const snapped =
      applySnap(
        component,

        pointerX,
        pointerY,

        component.rotationDeg
      );

    /*
      1. Zkusíme normální pohyb.
    */

    if (
      isPositionValid(
        component,

        snapped.x,
        snapped.y,

        component.rotationDeg
      )
    ) {
      setPlacedComponents(
        (items) =>
          items.map(
            (item) =>
              item.id ===
              componentId
                ? {
                    ...item,

                    xMm:
                      Math.round(
                        snapped.x
                      ),

                    yMm:
                      Math.round(
                        snapped.y
                      ),
                  }
                : item
          )
      );

      setEditorMessage("");

      return;
    }

    /*
      2. Pokud je tam překážka,
      zkusíme sklouznout pouze po X.
    */

    if (
      isPositionValid(
        component,

        snapped.x,
        component.yMm,

        component.rotationDeg
      )
    ) {
      setPlacedComponents(
        (items) =>
          items.map(
            (item) =>
              item.id ===
              componentId
                ? {
                    ...item,

                    xMm:
                      Math.round(
                        snapped.x
                      ),
                  }
                : item
          )
      );

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose Y."
      );

      return;
    }

    /*
      3. Potom pouze Y.
    */

    if (
      isPositionValid(
        component,

        component.xMm,
        snapped.y,

        component.rotationDeg
      )
    ) {
      setPlacedComponents(
        (items) =>
          items.map(
            (item) =>
              item.id ===
              componentId
                ? {
                    ...item,

                    yMm:
                      Math.round(
                        snapped.y
                      ),
                  }
                : item
          )
      );

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose X."
      );

      return;
    }

    /*
      4. Jinak objekt zůstane stát.
    */

    setEditorMessage(
      "Kolize s konstrukcí – objekt tudy neprojde."
    );
  }

  function handleComponentPointerUp(
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    setDraggingComponentId(
      null
    );

    if (
      event.currentTarget.hasPointerCapture(
        event.pointerId
      )
    ) {
      event.currentTarget.releasePointerCapture(
        event.pointerId
      );
    }
  }

  /* ================================================= */
  /* ROTATION                                         */
  /* ================================================= */

  function setSelectedRotation(
    requestedAngle: number
  ) {
    if (
      !selectedPlacedComponent
    ) {
      return;
    }

    if (
      selectedPlacedComponent.rotationMode ===
      "locked"
    ) {
      return;
    }

    let newAngle =
      normalizeAngle(
        requestedAngle
      );

    if (
      selectedPlacedComponent.rotationMode ===
      "step90"
    ) {
      newAngle =
        normalizeAngle(
          Math.round(
            newAngle / 90
          ) * 90
        );
    }

    const valid =
      isPositionValid(
        selectedPlacedComponent,

        selectedPlacedComponent.xMm,
        selectedPlacedComponent.yMm,

        newAngle
      );

    if (!valid) {
      setEditorMessage(
        "Rotaci blokuje konstrukce nebo hranice stánku."
      );

      return;
    }

    setPlacedComponents(
      (items) =>
        items.map(
          (item) =>
            item.id ===
            selectedPlacedComponent.id
              ? {
                  ...item,

                  rotationDeg:
                    newAngle,
                }
              : item
        )
    );

    setEditorMessage("");
  }

  function rotateSelectedBy(
    degrees: number
  ) {
    if (
      !selectedPlacedComponent
    ) {
      return;
    }

    setSelectedRotation(
      selectedPlacedComponent.rotationDeg +
        degrees
    );
  }

  /* ================================================= */
  /* DUPLICATE / DELETE                               */
  /* ================================================= */

  function duplicateSelectedComponent() {
    if (
      !selectedPlacedComponent
    ) {
      return;
    }

    const clone: PlacedComponent = {
      ...selectedPlacedComponent,

      id:
        selectedPlacedComponent.type +
        "-" +
        Date.now(),

      name:
        selectedPlacedComponent.name,

      xMm:
        selectedPlacedComponent.xMm +
        120,

      yMm:
        selectedPlacedComponent.yMm +
        120,
    };

    const snapped =
      applySnap(
        clone,

        clone.xMm,
        clone.yMm,

        clone.rotationDeg
      );

    const valid =
      isPositionValid(
        clone,

        snapped.x,
        snapped.y,

        clone.rotationDeg
      );

    if (valid) {
      clone.xMm =
        Math.round(
          snapped.x
        );

      clone.yMm =
        Math.round(
          snapped.y
        );
    } else {
      clone.xMm =
        selectedPlacedComponent.xMm;

      clone.yMm =
        selectedPlacedComponent.yMm;
    }

    setPlacedComponents(
      (items) => [
        ...items,
        clone,
      ]
    );

    setSelectedComponentId(
      clone.id
    );

    setEditorMessage("");
  }

  function deleteSelectedComponent() {
    if (
      !selectedComponentId
    ) {
      return;
    }

    setPlacedComponents(
      (items) =>
        items.filter(
          (item) =>
            item.id !==
            selectedComponentId
        )
    );

    setSelectedComponentId(
      null
    );

    setEditorMessage("");
  }

  function resetConfigurator() {
    setPlacedComponents([]);
    setSelectedComponentId(null);

    setEditorMessage("");
  }

  /* ================================================= */
  /* RENDER                                           */
  /* ================================================= */

  return (
    <main className="shell">
      {/* ================================================= */}
      {/* SIDEBAR                                         */}
      {/* ================================================= */}

      <aside className="sidebar">
        <a
          href="https://homeworkstudio.cz"
          className="logo"
        >
          <span className="logoMain">
            HOMEWORK
          </span>

          <span className="logoSub">
            STUDIO
          </span>
        </a>

        <nav className="nav">
          <button
            type="button"
            className="navItem active"
            onClick={startNewProject}
          >
            <span className="navIcon">
              ＋
            </span>

            Nový projekt
          </button>

          <button
            type="button"
            className="navItem"
          >
            <span className="navIcon">
              □
            </span>

            Projekty
          </button>

          <button
            type="button"
            className="navItem"
          >
            <span className="navIcon">
              ◇
            </span>

            Knihovna stánků
          </button>

          <button
            type="button"
            className="navItem"
          >
            <span className="navIcon">
              ▦
            </span>

            Komponenty
          </button>
        </nav>

        <div className="sidebarBottom">
          <div className="appVersion">
            HOMEWORK BOOTH

            <span>
              Generator v0.1
            </span>
          </div>
        </div>
      </aside>

      {/* ================================================= */}
      {/* MAIN                                            */}
      {/* ================================================= */}

      <section className="main">
        {/* ================================================= */}
        {/* TOPBAR                                         */}
        {/* ================================================= */}

        <header className="topbar">
          <div>
            <span className="sectionLabel">
              BOOTH GENERATOR
            </span>
          </div>

          <div className="steps">
            <div
              className={
                step >= 1
                  ? "step active"
                  : "step"
              }
            >
              <span>1</span>
              Projekt
            </div>

            <div className="stepLine" />

            <div
              className={
                step >= 2
                  ? "step active"
                  : "step"
              }
            >
              <span>2</span>
              Stánek
            </div>

            <div className="stepLine" />

            <div
              className={
                step >= 3
                  ? "step active"
                  : "step"
              }
            >
              <span>3</span>
              Konfigurace
            </div>

            <div className="stepLine" />

            <div className="step">
              <span>4</span>
              Vizualizace
            </div>

            <div className="stepLine" />

            <div className="step">
              <span>5</span>
              Export
            </div>
          </div>
        </header>

        {/* ================================================= */}
        {/* STEP 1                                          */}
        {/* ================================================= */}

        {step === 1 && (
          <div className="page">
            <div className="pageIntro">
              <div>
                <span className="eyebrow">
                  NOVÝ PROJEKT
                </span>

                <h1>
                  Vytvořit nový stánek
                </h1>

                <p>
                  Zadej základní informace.
                  Veletrh určuje ceník,
                  výchozí měnu a později také
                  logo a další pravidla projektu.
                </p>
              </div>

              <div className="projectNumber">
                <span>
                  PROJEKT
                </span>

                <strong>
                  NEW
                </strong>
              </div>
            </div>

            <div className="contentGrid">
              <section className="card formCard">
                <div className="cardHeader">
                  <div>
                    <span className="cardNumber">
                      01
                    </span>

                    <h2>
                      Informace o projektu
                    </h2>
                  </div>

                  <span className="required">
                    ZÁKLADNÍ ÚDAJE
                  </span>
                </div>

                <div className="form">
                  <label>
                    <span>
                      Veletrh
                    </span>

                    <select
                      value={fairId}
                      onChange={(event) =>
                        handleFairChange(
                          event.target.value
                        )
                      }
                    >
                      <option value="">
                        Vyber veletrh
                      </option>

                      {fairs.map(
                        (fair) => (
                          <option
                            key={
                              fair.id
                            }
                            value={
                              fair.id
                            }
                          >
                            {
                              fair.name
                            }
                          </option>
                        )
                      )}
                    </select>
                  </label>

                  {selectedFair && (
                    <div className="fairInfo">
                      <div>
                        <span>
                          CENÍK
                        </span>

                        <strong>
                          {
                            selectedFair.priceList
                          }
                        </strong>
                      </div>

                      <div>
                        <span>
                          VÝCHOZÍ MĚNA
                        </span>

                        <strong>
                          {
                            selectedFair.defaultCurrency
                          }
                        </strong>
                      </div>

                      <div>
                        <span>
                          LOGO
                        </span>

                        <strong>
                          Přiřazeno k veletrhu
                        </strong>
                      </div>
                    </div>
                  )}

                  <div className="twoColumns">
                    <label>
                      <span>
                        Firma / vystavovatel
                      </span>

                      <input
                        value={company}
                        onChange={(event) =>
                          setCompany(
                            event.target.value
                          )
                        }
                        placeholder="Název společnosti"
                      />
                    </label>

                    <label>
                      <span>
                        Kontakt
                      </span>

                      <input
                        value={contact}
                        onChange={(event) =>
                          setContact(
                            event.target.value
                          )
                        }
                        placeholder="Jméno / e-mail"
                      />
                    </label>
                  </div>

                  <div className="currencySection">
                    <span className="fieldTitle">
                      Měna projektu
                    </span>

                    <div className="currencyButtons">
                      <button
                        type="button"
                        className={
                          currency ===
                          "CZK"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() =>
                          setCurrency(
                            "CZK"
                          )
                        }
                      >
                        <strong>
                          CZK
                        </strong>

                        <span>
                          Kč
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          currency ===
                          "EUR"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() =>
                          setCurrency(
                            "EUR"
                          )
                        }
                      >
                        <strong>
                          EUR
                        </strong>

                        <span>
                          €
                        </span>
                      </button>
                    </div>

                    <p className="currencyHint">
                      Výchozí měna se nastaví podle veletrhu,
                      ale můžeš ji pro konkrétní projekt změnit.
                    </p>
                  </div>

                  <div className="projectType">
                    <span className="fieldTitle">
                      Typ projektu
                    </span>

                    <div className="typeCards">
                      <button
                        type="button"
                        className={
                          type ===
                          "typovy"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() =>
                          setType(
                            "typovy"
                          )
                        }
                      >
                        <div className="typeVisual">
                          <div className="typePlan">
                            <span className="wall wallTop" />
                            <span className="wall wallLeft" />
                          </div>
                        </div>

                        <div>
                          <strong>
                            Typový stánek
                          </strong>

                          <p>
                            Výběr z připravených
                            rozměrů a variant
                            konstrukce.
                          </p>
                        </div>

                        <span className="radio">
                          {type ===
                            "typovy" && (
                            <span />
                          )}
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          type ===
                          "individualni"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() =>
                          setType(
                            "individualni"
                          )
                        }
                      >
                        <div className="typeVisual">
                          <div className="customShape" />
                        </div>

                        <div>
                          <strong>
                            Individuální stánek
                          </strong>

                          <p>
                            Vlastní rozměry,
                            konstrukce a půdorys
                            projektu.
                          </p>
                        </div>

                        <span className="radio">
                          {type ===
                            "individualni" && (
                            <span />
                          )}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="summaryCard">
                <div className="summaryHeader">
                  <span>
                    NÁHLED PROJEKTU
                  </span>

                  <span className="draft">
                    DRAFT
                  </span>
                </div>

                <div className="summaryBody">
                  <div className="emptyPreview">
                    <div className="previewCube">
                      <span className="cubeBack" />
                      <span className="cubeSide" />
                      <span className="cubeFloor" />
                    </div>

                    <strong>
                      {company
                        ? company
                        : "Nový projekt"}
                    </strong>

                    <p>
                      Náhled stánku se zobrazí po
                      výběru konstrukce.
                    </p>
                  </div>
                </div>

                <div className="summaryInfo">
                  <div>
                    <span>
                      VELETRH
                    </span>

                    <strong>
                      {selectedFair
                        ? selectedFair.name
                        : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      FIRMA
                    </span>

                    <strong>
                      {company || "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      CENÍK
                    </span>

                    <strong>
                      {selectedFair
                        ? selectedFair.priceList
                        : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      MĚNA
                    </span>

                    <strong>
                      {currency ===
                      "CZK"
                        ? "CZK / Kč"
                        : "EUR / €"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      TYP
                    </span>

                    <strong>
                      {type ===
                      "typovy"
                        ? "Typový"
                        : "Individuální"}
                    </strong>
                  </div>
                </div>
              </aside>
            </div>

            <footer className="pageFooter">
              <span>
                Projekt zatím není uložen.
              </span>

              <button
                className="primaryButton"
                onClick={() =>
                  setStep(2)
                }
              >
                Pokračovat

                <span>
                  →
                </span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 2                                          */}
        {/* ================================================= */}

        {step === 2 && (
          <div className="page">
            <button
              className="back"
              onClick={() =>
                setStep(1)
              }
            >
              ← Zpět na projekt
            </button>

            <div className="pageIntro">
              <div>
                <span className="eyebrow">
                  KROK 02 / ZÁKLAD KONSTRUKCE
                </span>

                <h1>
                  Vyber základ konstrukce
                </h1>

                <p>
                  Nejprve vyber typ stánku.
                  Pokud konstrukce obsahuje více
                  variant, zobrazí se jejich
                  výběr automaticky.
                </p>
              </div>
            </div>

            <div className="projectContext">
              <div>
                <span>
                  VELETRH
                </span>

                <strong>
                  {selectedFair?.name ||
                    "—"}
                </strong>
              </div>

              <div>
                <span>
                  FIRMA
                </span>

                <strong>
                  {company || "—"}
                </strong>
              </div>

              <div>
                <span>
                  CENÍK
                </span>

                <strong>
                  {selectedFair?.priceList ||
                    "—"}
                </strong>
              </div>

              <div>
                <span>
                  MĚNA
                </span>

                <strong>
                  {currency}
                </strong>
              </div>
            </div>

            {type ===
            "typovy" ? (
              <>
                <section className="boothSelectionSection">
                  <div className="selectionTitle">
                    <div>
                      <span>
                        01
                      </span>

                      <div>
                        <small>
                          ZÁKLAD
                        </small>

                        <h2>
                          Konstrukce stánku
                        </h2>
                      </div>
                    </div>

                    <p>
                      Vyber základní typ konstrukce.
                    </p>
                  </div>

                  <div className="boothTypeGrid">
                    {boothTypes.map(
                      (booth) => {
                        const selected =
                          selectedBoothId ===
                          booth.id;

                        return (
                          <button
                            key={
                              booth.id
                            }
                            type="button"
                            className={
                              selected
                                ? "boothTypeCard selected"
                                : "boothTypeCard"
                            }
                            onClick={() =>
                              handleBoothSelect(
                                booth.id
                              )
                            }
                          >
                            <div className="boothCardCode">
                              {
                                booth.code
                              }
                            </div>

                            {!booth.configReady && (
                              <span className="cadPending">
                                CAD ČEKÁ
                              </span>
                            )}

                            <div className="constructionPreview">
                              <div className="constructionShape">
                                <span className="constructionWallTop" />
                                <span className="constructionWallLeft" />
                              </div>
                            </div>

                            <div className="boothTypeContent">
                              <h3>
                                {
                                  booth.name
                                }
                              </h3>

                              <p>
                                {
                                  booth.description
                                }
                              </p>

                              <div className="boothMeta">
                                <span>
                                  {
                                    booth.size
                                  }
                                </span>

                                {booth
                                  .variants
                                  .length >
                                0 ? (
                                  <strong>
                                    {
                                      booth
                                        .variants
                                        .length
                                    }{" "}
                                    varianty
                                  </strong>
                                ) : (
                                  <strong>
                                    Bez variant
                                  </strong>
                                )}
                              </div>
                            </div>

                            {selected && (
                              <span className="boothCheck">
                                ✓
                              </span>
                            )}
                          </button>
                        );
                      }
                    )}
                  </div>
                </section>

                {selectedBooth &&
                  selectedBooth
                    .variants
                    .length >
                    0 && (
                    <section className="variantSection">
                      <div className="selectionTitle">
                        <div>
                          <span>
                            02
                          </span>

                          <div>
                            <small>
                              VARIANTA
                            </small>

                            <h2>
                              {
                                selectedBooth.name
                              }
                            </h2>
                          </div>
                        </div>

                        <p>
                          Vyber konkrétní variantu konstrukce.
                        </p>
                      </div>

                      <div className="variantGrid">
                        {selectedBooth.variants.map(
                          (
                            variant,
                            index
                          ) => {
                            const selected =
                              selectedVariantId ===
                              variant.id;

                            return (
                              <button
                                key={
                                  variant.id
                                }
                                type="button"
                                className={
                                  selected
                                    ? "variantCard selected"
                                    : "variantCard"
                                }
                                onClick={() =>
                                  setSelectedVariantId(
                                    variant.id
                                  )
                                }
                              >
                                <div className="variantPreview">
                                  <div
                                    className={`variantShape variantShape${
                                      index +
                                      1
                                    }`}
                                  >
                                    <span className="variantWallA" />
                                    <span className="variantWallB" />
                                  </div>
                                </div>

                                <div className="variantContent">
                                  <span>
                                    {
                                      selectedBooth.code
                                    }{" "}
                                    / V
                                    {index +
                                      1}
                                  </span>

                                  <strong>
                                    {
                                      variant.name
                                    }
                                  </strong>
                                </div>

                                {selected && (
                                  <span className="variantCheck">
                                    ✓
                                  </span>
                                )}
                              </button>
                            );
                          }
                        )}
                      </div>
                    </section>
                  )}

                {selectedBooth &&
                  selectedBooth
                    .variants
                    .length ===
                    0 && (
                    <div className="noVariantInfo">
                      <div className="noVariantIcon">
                        ✓
                      </div>

                      <div>
                        <strong>
                          {
                            selectedBooth.name
                          }
                        </strong>

                        {selectedBooth.configReady ? (
                          <p>
                            Tato konstrukce nemá
                            další varianty. Můžeš
                            pokračovat přímo do
                            konfigurátoru.
                          </p>
                        ) : (
                          <p>
                            Výběr je připravený,
                            ale konfigurátor čeká
                            na přesnou CAD
                            geometrii této
                            konstrukce.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <div className="individualPlaceholder">
                <span>
                  INDIVIDUÁLNÍ PROJEKT
                </span>

                <h2>
                  Editor vlastního půdorysu
                </h2>

                <p>
                  Individuální konstrukce
                  připravíme jako samostatnou
                  část generátoru.
                </p>
              </div>
            )}

            <footer className="pageFooter">
              <button
                className="secondaryButton"
                onClick={() =>
                  setStep(1)
                }
              >
                Zpět
              </button>

              <button
                className="primaryButton"
                disabled={
                  !canOpenConfigurator
                }
                onClick={() => {
                  if (
                    canOpenConfigurator
                  ) {
                    setStep(
                      3
                    );
                  }
                }}
              >
                Otevřít konfigurátor

                <span>
                  →
                </span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 3                                          */}
        {/* ================================================= */}

        {step === 3 &&
          selectedBooth &&
          selectedBooth.widthMm &&
          selectedBooth.depthMm && (
            <div className="configuratorPage">
              {/* HEADER */}

              <div className="configuratorHeader">
                <div>
                  <button
                    className="back"
                    onClick={() =>
                      setStep(2)
                    }
                  >
                    ← Zpět na výběr stánku
                  </button>

                  <span className="eyebrow">
                    KROK 03 / KONFIGURACE
                  </span>

                  <h1>
                    {
                      selectedBooth.name
                    }
                  </h1>
                </div>

                <div className="configuratorHeaderActions">
                  <div className="viewSwitch">
                    <button className="viewButton active">
                      2D
                    </button>

                    <button
                      className="viewButton"
                      disabled
                    >
                      3D
                    </button>
                  </div>

                  <button
                    className="lightButton"
                    onClick={
                      resetConfigurator
                    }
                  >
                    Reset rozmístění
                  </button>
                </div>
              </div>

              {/* WORKSPACE */}

              <div className="configuratorWorkspace">
                {/* COMPONENT LIBRARY */}

                <aside className="componentLibrary">
                  <div className="panelHeader">
                    <span>
                      KOMPONENTY
                    </span>

                    <strong>
                      Knihovna
                    </strong>
                  </div>

                  <div className="librarySection">
                    <span className="libraryTitle">
                      TEST MOBILIÁŘE
                    </span>

                    <button
                      className="libraryItem"
                      onClick={
                        addCabinet
                      }
                    >
                      <span className="libraryItemIcon cabinetIcon">
                        ▭
                      </span>

                      <span className="libraryItemText">
                        <strong>
                          Skříňka
                        </strong>

                        <small>
                          800 × 400 mm
                        </small>

                        <em>
                          rotace po 90°
                        </em>
                      </span>

                      <span className="libraryAdd">
                        +
                      </span>
                    </button>

                    <button
                      className="libraryItem"
                      onClick={
                        addChair
                      }
                    >
                      <span className="libraryItemIcon chairIcon">
                        ◇
                      </span>

                      <span className="libraryItemText">
                        <strong>
                          Židle
                        </strong>

                        <small>
                          450 × 500 mm
                        </small>

                        <em>
                          volná rotace
                        </em>
                      </span>

                      <span className="libraryAdd">
                        +
                      </span>
                    </button>

                    <p className="libraryHint">
                      Zatím testujeme ovládání.
                      Později sem připojíme přesné
                      CAD komponenty 1:1.
                    </p>
                  </div>

                  <div className="librarySection">
                    <span className="libraryTitle">
                      PŘIPRAVUJEME
                    </span>

                    <div className="futureLibraryList">
                      <span>
                        Vitríny
                      </span>

                      <span>
                        Pulty
                      </span>

                      <span>
                        Stoly
                      </span>

                      <span>
                        Židle
                      </span>

                      <span>
                        Barovky
                      </span>

                      <span>
                        Police
                      </span>

                      <span>
                        Elektro
                      </span>
                    </div>
                  </div>
                </aside>

                {/* PLAN */}

                <section className="planWorkspace">
                  <div className="planToolbar">
                    <div>
                      <span>
                        PŮDORYS
                      </span>

                      <strong>
                        {
                          selectedBooth.widthMm
                        }{" "}
                        ×{" "}
                        {
                          selectedBooth.depthMm
                        }{" "}
                        mm
                      </strong>
                    </div>

                    <div className="planToolbarInfo">
                      <span>
                        GRID 250 mm
                      </span>

                      <span>
                        SNAP 40 mm
                      </span>

                      <span className="collisionOn">
                        KOLIZE ON
                      </span>
                    </div>
                  </div>

                  {/* OBJECT NAVIGATOR */}

                  <div
                    className={
                      selectedPlacedComponent
                        ? "objectNavigator active"
                        : "objectNavigator"
                    }
                  >
                    {selectedPlacedComponent ? (
                      <>
                        <div className="navigatorObject">
                          <span>
                            VYBRANÝ OBJEKT
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.name
                            }
                          </strong>
                        </div>

                        <div className="navigatorCoords">
                          <div>
                            <span>
                              X
                            </span>

                            <strong>
                              {Math.round(
                                selectedPlacedComponent.xMm
                              )}{" "}
                              mm
                            </strong>
                          </div>

                          <div>
                            <span>
                              Y
                            </span>

                            <strong>
                              {Math.round(
                                selectedPlacedComponent.yMm
                              )}{" "}
                              mm
                            </strong>
                          </div>
                        </div>

                        <div className="navigatorDivider" />

                        <div className="rotationNavigator">
                          <div className="rotationNavigatorTitle">
                            <span>
                              ROTACE
                            </span>

                            <strong>
                              {
                                selectedPlacedComponent.rotationDeg
                              }
                              °
                            </strong>
                          </div>

                          {selectedPlacedComponent.rotationMode ===
                          "free" ? (
                            <div className="freeRotation">
                              <button
                                onClick={() =>
                                  rotateSelectedBy(
                                    -5
                                  )
                                }
                              >
                                −5°
                              </button>

                              <input
                                className="rotationSlider"
                                type="range"
                                min="0"
                                max="359"
                                step="1"
                                value={
                                  selectedPlacedComponent.rotationDeg
                                }
                                onChange={(event) =>
                                  setSelectedRotation(
                                    Number(
                                      event
                                        .target
                                        .value
                                    )
                                  )
                                }
                              />

                              <button
                                onClick={() =>
                                  rotateSelectedBy(
                                    5
                                  )
                                }
                              >
                                +5°
                              </button>

                              <input
                                className="rotationNumber"
                                type="number"
                                min="0"
                                max="359"
                                value={
                                  selectedPlacedComponent.rotationDeg
                                }
                                onChange={(event) =>
                                  setSelectedRotation(
                                    Number(
                                      event
                                        .target
                                        .value
                                    )
                                  )
                                }
                              />
                            </div>
                          ) : (
                            <div className="stepRotation">
                              {[
                                0,
                                90,
                                180,
                                270,
                              ].map(
                                (
                                  angle
                                ) => (
                                  <button
                                    key={
                                      angle
                                    }
                                    className={
                                      selectedPlacedComponent.rotationDeg ===
                                      angle
                                        ? "active"
                                        : ""
                                    }
                                    onClick={() =>
                                      setSelectedRotation(
                                        angle
                                      )
                                    }
                                  >
                                    {
                                      angle
                                    }
                                    °
                                  </button>
                                )
                              )}
                            </div>
                          )}
                        </div>

                        <div className="navigatorDivider" />

                        <div className="navigatorActions">
                          <button
                            onClick={
                              duplicateSelectedComponent
                            }
                          >
                            Duplikovat
                          </button>

                          <button
                            className="deleteNavigatorButton"
                            onClick={
                              deleteSelectedComponent
                            }
                          >
                            Smazat
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="navigatorEmpty">
                        Vyber objekt v půdorysu – zde se zobrazí jeho
                        pozice a ovládání rotace.
                      </div>
                    )}
                  </div>

                  {editorMessage && (
                    <div className="editorMessage">
                      <span>
                        !
                      </span>

                      {
                        editorMessage
                      }
                    </div>
                  )}

                  <div className="canvasArea">
                    <div className="dimensionTop">
                      <span>
                        {
                          selectedBooth.widthMm
                        }{" "}
                        mm
                      </span>
                    </div>

                    <div className="dimensionLeft">
                      <span>
                        {
                          selectedBooth.depthMm
                        }{" "}
                        mm
                      </span>
                    </div>

                    <div
                      ref={canvasRef}
                      className="boothCanvas"
                      style={{
                        aspectRatio: `${selectedBooth.widthMm} / ${selectedBooth.depthMm}`,
                      }}
                      onPointerDown={() => {
                        setSelectedComponentId(
                          null
                        );

                        setEditorMessage(
                          ""
                        );
                      }}
                    >
                      {/* CARPET */}

                      <div className="carpetLayer">
                        <span className="carpetLabel">
                          KOBEREC 2000 × 2000
                        </span>
                      </div>

                      {/* FIXED CONSTRUCTION */}

                      {selectedBooth.id ===
                        "koje-2x2" && (
                        <>
                          <div className="fixedWall backFixedWall">
                            <span>
                              2000
                            </span>
                          </div>

                          <div className="fixedWall leftFixedWall">
                            <span>
                              1000
                            </span>
                          </div>

                          <div className="fixedWall rightFixedWall">
                            <span>
                              1000
                            </span>
                          </div>

                          <div className="cornerProfile profileTopLeft" />
                          <div className="cornerProfile profileTopCenter" />
                          <div className="cornerProfile profileTopRight" />
                          <div className="cornerProfile profileLeftEnd" />
                          <div className="cornerProfile profileRightEnd" />
                        </>
                      )}

                      {/* COMPONENTS */}

                      {placedComponents.map(
                        (item) => {
                          const selected =
                            item.id ===
                            selectedComponentId;

                          return (
                            <button
                              key={
                                item.id
                              }
                              type="button"
                              className={[
                                "placedComponent",

                                item.type ===
                                "chair"
                                  ? "chairComponent"
                                  : "cabinetComponent",

                                selected
                                  ? "selected"
                                  : "",
                              ]
                                .filter(
                                  Boolean
                                )
                                .join(
                                  " "
                                )}
                              style={{
                                left: `${
                                  (item.xMm /
                                    selectedBooth.widthMm!) *
                                  100
                                }%`,

                                top: `${
                                  (item.yMm /
                                    selectedBooth.depthMm!) *
                                  100
                                }%`,

                                width: `${
                                  (item.widthMm /
                                    selectedBooth.widthMm!) *
                                  100
                                }%`,

                                height: `${
                                  (item.depthMm /
                                    selectedBooth.depthMm!) *
                                  100
                                }%`,

                                transform: `translate(-50%, -50%) rotate(${item.rotationDeg}deg)`,
                              }}
                              onPointerDown={(
                                event
                              ) =>
                                handleComponentPointerDown(
                                  event,
                                  item.id
                                )
                              }
                              onPointerMove={(
                                event
                              ) =>
                                handleComponentPointerMove(
                                  event,
                                  item.id
                                )
                              }
                              onPointerUp={
                                handleComponentPointerUp
                              }
                            >
                              {item.type ===
                                "chair" && (
                                <i className="frontMarker">
                                  ▲
                                </i>
                              )}

                              <span className="placedComponentName">
                                {
                                  item.name
                                }
                              </span>

                              <small>
                                {
                                  item.widthMm
                                }{" "}
                                ×{" "}
                                {
                                  item.depthMm
                                }
                              </small>
                            </button>
                          );
                        }
                      )}
                    </div>

                    <div className="canvasLegend">
                      <div>
                        <span className="legendBox legendConstruction" />

                        Konstrukce – blokuje pohyb
                      </div>

                      <div>
                        <span className="legendBox legendComponent" />

                        Mobiliář
                      </div>

                      <div>
                        <span className="legendBox legendSelected" />

                        Vybraný objekt
                      </div>
                    </div>
                  </div>
                </section>

                {/* PROPERTIES */}

                <aside className="propertyPanel">
                  <div className="panelHeader">
                    <span>
                      VLASTNOSTI
                    </span>

                    <strong>
                      Projekt
                    </strong>
                  </div>

                  <div className="propertySection">
                    <div className="propertyRow">
                      <span>
                        Veletrh
                      </span>

                      <strong>
                        {selectedFair?.name ||
                          "—"}
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Firma
                      </span>

                      <strong>
                        {company ||
                          "—"}
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Konstrukce
                      </span>

                      <strong>
                        {
                          selectedBooth.code
                        }
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Měna
                      </span>

                      <strong>
                        {
                          currency
                        }
                      </strong>
                    </div>
                  </div>

                  <div className="propertySection">
                    <span className="propertySectionTitle">
                      KONSTRUKCE
                    </span>

                    <div className="propertyRow">
                      <span>
                        Plocha
                      </span>

                      <strong>
                        2000 × 2000 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Výška
                      </span>

                      <strong>
                        2500 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Límec
                      </span>

                      <strong>
                        300 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Octanorm
                      </span>

                      <strong>
                        80 mm
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>
                        Kolize
                      </span>

                      <strong className="statusEnabled">
                        Aktivní
                      </strong>
                    </div>
                  </div>

                  <div className="propertySection">
                    <span className="propertySectionTitle">
                      VYBRANÝ OBJEKT
                    </span>

                    {selectedPlacedComponent ? (
                      <>
                        <div className="selectedComponentCard">
                          <span>
                            {
                              selectedPlacedComponent.name
                            }
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.widthMm
                            }{" "}
                            ×{" "}
                            {
                              selectedPlacedComponent.depthMm
                            }{" "}
                            mm
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            X – střed
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.xMm
                            }{" "}
                            mm
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Y – střed
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.yMm
                            }{" "}
                            mm
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Rotace
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.rotationDeg
                            }
                            °
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Režim
                          </span>

                          <strong>
                            {selectedPlacedComponent.rotationMode ===
                            "free"
                              ? "Volná 360°"
                              : "Po 90°"}
                          </strong>
                        </div>

                        <div className="propertyRow">
                          <span>
                            Cenová skupina
                          </span>

                          <strong>
                            Mobiliář
                          </strong>
                        </div>

                        <button
                          className="inspectorDelete"
                          onClick={
                            deleteSelectedComponent
                          }
                        >
                          Smazat objekt
                        </button>
                      </>
                    ) : (
                      <p className="emptyInspector">
                        Klikni na mobiliář v půdorysu.
                      </p>
                    )}
                  </div>
                </aside>
              </div>

              {/* BOTTOM */}

              <div className="configuratorBottomBar">
                <div className="pricingInfo">
                  <div>
                    <span>
                      CENA KONSTRUKCE
                    </span>

                    <strong>
                      FIXNÍ TYPOVKA
                    </strong>
                  </div>

                  <div>
                    <span>
                      ÚPRAVY KONSTRUKCE
                    </span>

                    <strong>
                      cenu nemění
                    </strong>
                  </div>

                  <div>
                    <span>
                      MOBILIÁŘ
                    </span>

                    <strong>
                      {
                        placedComponents.length
                      }{" "}
                      položek
                    </strong>
                  </div>
                </div>

                <button
                  className="primaryButton"
                  disabled
                >
                  Pokračovat na vizualizaci

                  <span>
                    →
                  </span>
                </button>
              </div>
            </div>
          )}
      </section>
    </main>
  );
}