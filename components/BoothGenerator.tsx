"use client";

import {
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { boothTypes } from "../data/booths";
import { placeComponent } from "../data/components";
import { fairs } from "../data/fairs";
import {
  DEFAULT_REALIZATION_PROFILE_ID,
  realizationProfiles,
} from "../data/realizationProfiles";
import type {
  Currency,
  ComponentDefinition,
  Notes,
  PlacedComponent,
  ProjectType,
  RotationControlMode,
} from "../domain/models";
import { getMasterReferenceModel } from "../domain/cad3d";
import { isObjectLocked, toggleUserLock } from "../domain/locking";
import {
  createEmptyNotes,
  notesForEntity,
  updateEntityNotes,
  updateNotes,
  type NoteField,
  type NotesByEntityId,
} from "../domain/notes";
import { toggleVisibility } from "../domain/visibility";
import {
  applySnap as snapPlacement,
  isPlacementValid,
  tryMoveComponent,
} from "../geometry/placement";
import { quickRotation, rotationForMode } from "../geometry/rotation";
import { useBoothViewport } from "../hooks/useBoothViewport";
import { AppSidebar } from "./AppSidebar";
import { StepHeader } from "./StepHeader";
import { ComponentLibrary } from "./configurator/ComponentLibrary";
import { BoothCadViewer } from "./configurator/BoothCadViewer";
import { BoothCadPlanView } from "./configurator/BoothCadPlanView";
import { ConfiguratorHelp } from "./configurator/ConfiguratorHelp";
import { NotesEditor } from "./configurator/NotesEditor";
import { CoordinateInput } from "./configurator/CoordinateInput";
import { PricingBar } from "./configurator/PricingBar";
import { RotationNavigator } from "./configurator/RotationNavigator";
import { ScenePanel } from "./configurator/ScenePanel";
import { ViewportToolbar } from "./configurator/ViewportToolbar";

export default function BoothGenerator() {
  const [step, setStep] =
    useState(1);

  const [isSidebarCollapsed, setIsSidebarCollapsed] =
    useState(false);

  const [isHelpOpen, setIsHelpOpen] =
    useState(false);

  const [editorView, setEditorView] =
    useState<"2d" | "3d">("2d");

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

  const [realizationProfileId, setRealizationProfileId] =
    useState(DEFAULT_REALIZATION_PROFILE_ID);

  const [projectNotes, setProjectNotes] =
    useState<Notes>(() => createEmptyNotes());

  const [isProjectNotesOpen, setIsProjectNotesOpen] =
    useState(false);

  const [assemblyNotes, setAssemblyNotes] =
    useState<Notes>(() => createEmptyNotes());

  const [constructionNotes, setConstructionNotes] =
    useState<NotesByEntityId>({});

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
    selectedConstructionPartId,
    setSelectedConstructionPartId,
  ] = useState<string | null>(null);

  const [
    constructionUserLocks,
    setConstructionUserLocks,
  ] = useState<Record<string, boolean>>({});

  const [
    constructionVisibility,
    setConstructionVisibility,
  ] = useState<Record<string, boolean>>({});

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

  const selectedRealizationProfile = realizationProfiles.find(
    (profile) => profile.id === realizationProfileId,
  );

  const hasProjectNotes = Boolean(
    projectNotes.internalNote.trim() || projectNotes.customerNote.trim(),
  );

  const selectedBooth =
    boothTypes.find(
      (booth) =>
        booth.id ===
        selectedBoothId
    );

  const selectedBoothMasterModel = getMasterReferenceModel(
    selectedBooth?.assets,
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

  const selectedPlacedComponentLocked =
    selectedPlacedComponent
      ? isObjectLocked(selectedPlacedComponent)
      : false;

  const selectedConstructionPart =
    selectedConstructionPartId && selectedConstructionPartId !== "assembly"
      ? selectedBooth?.constructionParts.find(
          (part) => part.id === selectedConstructionPartId,
        )
      : undefined;

  const selectedConstructionName =
    selectedConstructionPartId === "assembly"
      ? selectedBooth?.name
      : selectedConstructionPart?.name;

  const selectedConstructionLayer =
    selectedConstructionPartId === "assembly"
      ? "Sestava"
      : selectedConstructionPart?.planViewType === "overhead"
        ? "Horní konstrukce"
        : "Konstrukce u podlahy";

  const selectedConstructionLocked =
    selectedConstructionPartId === "assembly"
      ? Boolean(
          selectedBooth &&
            (selectedBooth.systemLocked ||
              (constructionUserLocks.assembly ?? selectedBooth.userLocked)),
        )
      : Boolean(
          selectedConstructionPart &&
            (selectedConstructionPart.systemLocked ||
              (constructionUserLocks[selectedConstructionPart.id] ??
                selectedConstructionPart.userLocked)),
        );

  const selectedConstructionNotes =
    selectedConstructionPartId === "assembly"
      ? assemblyNotes
      : selectedConstructionPartId
        ? notesForEntity(constructionNotes, selectedConstructionPartId)
        : undefined;

  const constructionAssemblyVisible = selectedBooth
    ? (constructionVisibility.assembly ?? selectedBooth.visible)
    : true;

  const boothViewport = useBoothViewport({
    worldWidthMm: selectedBooth?.widthMm ?? 2000,
    worldHeightMm: selectedBooth?.depthMm ?? 2000,
    enabled: step === 3 && Boolean(selectedBooth),
  });

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
    setEditorView("2d");

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});

    setEditorMessage("");
  }

  function handleVariantSelect(variantId: string) {
    if (variantId === selectedVariantId) {
      return;
    }

    setSelectedVariantId(variantId);
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});
  }

  function startNewProject() {
    setStep(1);

    setType("typovy");
    setEditorView("2d");

    setFairId("");
    setCompany("");
    setContact("");

    setCurrency("CZK");
    setRealizationProfileId(DEFAULT_REALIZATION_PROFILE_ID);
    setProjectNotes(createEmptyNotes());
    setIsProjectNotesOpen(false);
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});

    setSelectedBoothId("");
    setSelectedVariantId("");

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});

    setDraggingComponentId(null);

    setEditorMessage("");
  }

  /* ================================================= */
  /* COLLISION                                        */
  /* ================================================= */



  function isPositionValid(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    return selectedBooth
      ? isPlacementValid(selectedBooth, component, {
          x: centerX,
          y: centerY,
          rotationDeg,
        })
      : false;
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
    return selectedBooth
      ? snapPlacement(
          selectedBooth,
          component,
          centerX,
          centerY,
          rotationDeg
        )
      : { x: centerX, y: centerY };
  }

  /* ================================================= */
  /* ADD COMPONENTS                                   */
  /* ================================================= */

  function addComponent(definition: ComponentDefinition) {
    const component = placeComponent(
      definition,
      `${definition.type}-${Date.now()}`,
      1000,
      1500
    );

    setPlacedComponents((items) => [...items, component]);
    setSelectedComponentId(component.id);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  /* ================================================= */
  /* MOVE                                             */
  /* ================================================= */

  function handleComponentPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    if (
      event.button !== 0 ||
      boothViewport.isSpacePressed
    ) {
      return;
    }

    const component = placedComponents.find(
      (item) => item.id === componentId
    );

    event.stopPropagation();

    setSelectedComponentId(
      componentId
    );
    setSelectedConstructionPartId(null);

    if (!component || isObjectLocked(component)) {
      setDraggingComponentId(null);
      setEditorMessage("");
      return;
    }

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

    if (isObjectLocked(component)) {
      setDraggingComponentId(null);
      return;
    }

    const pointer = boothViewport.clientToWorld(
      event.clientX,
      event.clientY
    );

    if (!pointer) {
      return;
    }

    const snapped =
      applySnap(
        component,

        pointer.x,
        pointer.y,

        component.rotationDeg
      );

    const moveComponent = (movedComponent: PlacedComponent) => {
      setPlacedComponents((items) =>
        items.map((item) =>
          item.id === componentId ? movedComponent : item
        )
      );
    };

    const directMove = tryMoveComponent(
      selectedBooth,
      component,
      Math.round(snapped.x),
      Math.round(snapped.y),
    );

    if (directMove.accepted) {
      moveComponent(directMove.component);

      setEditorMessage("");

      return;
    }

    /*
      2. Pokud je tam překážka,
      zkusíme sklouznout pouze po X.
    */

    const xOnlyMove = tryMoveComponent(
      selectedBooth,
      component,
      Math.round(snapped.x),
      component.yMm,
    );

    if (xOnlyMove.accepted) {
      moveComponent(xOnlyMove.component);

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose Y."
      );

      return;
    }

    /*
      3. Potom pouze Y.
    */

    const yOnlyMove = tryMoveComponent(
      selectedBooth,
      component,
      component.xMm,
      Math.round(snapped.y),
    );

    if (yOnlyMove.accepted) {
      moveComponent(yOnlyMove.component);

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

  function handleViewportPointerDown(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    if (boothViewport.startPan(event)) {
      return;
    }

    if (event.button === 0) {
      setSelectedComponentId(null);
      setSelectedConstructionPartId(null);
      setEditorMessage("");
    }
  }

  /* ================================================= */
  /* ROTATION                                         */
  /* ================================================= */

  function setSelectedRotation(
    requestedAngle: number
  ) {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent)
    ) {
      return;
    }

    const newAngle = rotationForMode(
      selectedPlacedComponent.rotation,
      selectedPlacedComponent.rotationMode,
      requestedAngle,
      selectedPlacedComponent.rotationDeg
    );

    if (
      selectedPlacedComponent.rotation.locked ||
      newAngle === selectedPlacedComponent.rotationDeg
    ) {
      return;
    }

    const valid = isPositionValid(
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

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationDeg: newAngle }
          : item
      )
    );
    setEditorMessage("");
  }

  function setSelectedQuickRotation(
    requestedAngle: number
  ) {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent)
    ) {
      return;
    }

    const newAngle = quickRotation(
      selectedPlacedComponent.rotation,
      requestedAngle,
      selectedPlacedComponent.rotationDeg
    );

    if (
      selectedPlacedComponent.rotation.locked ||
      newAngle === selectedPlacedComponent.rotationDeg
    ) {
      return;
    }

    if (
      !isPositionValid(
        selectedPlacedComponent,
        selectedPlacedComponent.xMm,
        selectedPlacedComponent.yMm,
        newAngle
      )
    ) {
      setEditorMessage(
        "Rotaci blokuje konstrukce nebo hranice stánku."
      );
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationDeg: newAngle }
          : item
      )
    );
    setEditorMessage("");
  }

  function setSelectedRotationMode(
    mode: RotationControlMode
  ) {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent) ||
      selectedPlacedComponent.rotation.locked ||
      (mode === "free" &&
        !selectedPlacedComponent.rotation.allowFreeRotation)
    ) {
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationMode: mode }
          : item
      )
    );
  }



  /* ================================================= */
  /* DUPLICATE / DELETE                               */
  /* ================================================= */

  function duplicateSelectedComponent() {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent)
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
    setSelectedConstructionPartId(null);

    setEditorMessage("");
  }

  function deleteSelectedComponent() {
    if (
      !selectedComponentId ||
      selectedPlacedComponentLocked
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

  function commitSelectedCoordinate(
    axis: "x" | "y",
    valueMm: number,
  ): boolean {
    if (!selectedBooth || !selectedPlacedComponent) {
      return false;
    }

    const move = tryMoveComponent(
      selectedBooth,
      selectedPlacedComponent,
      axis === "x" ? valueMm : selectedPlacedComponent.xMm,
      axis === "y" ? valueMm : selectedPlacedComponent.yMm,
    );

    if (!move.accepted) {
      setEditorMessage(
        move.reason === "locked"
          ? "Objekt je zamčený a jeho pozici nelze změnit."
          : "Neplatná pozice – objekt zůstává na původním místě.",
      );
      return false;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === move.component.id ? move.component : item
      )
    );
    setEditorMessage("");

    return true;
  }

  function selectSceneComponent(componentId: string) {
    setSelectedComponentId(componentId);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  function selectConstructionPart(partId: string) {
    setSelectedComponentId(null);
    setSelectedConstructionPartId(partId);
    setEditorMessage("");
  }

  function toggleComponentLock(componentId: string) {
    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === componentId
          ? toggleUserLock(item)
          : item
      )
    );
  }

  function toggleComponentVisibility(componentId: string) {
    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === componentId
          ? toggleVisibility(item)
          : item
      )
    );
  }

  function updateSelectedComponentNote(
    field: NoteField,
    value: string,
  ) {
    if (!selectedComponentId) {
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedComponentId
          ? { ...item, ...updateNotes(item, field, value) }
          : item
      )
    );
  }

  function updateProjectNote(field: NoteField, value: string) {
    setProjectNotes((notes) => updateNotes(notes, field, value));
  }

  function updateSelectedConstructionNote(
    field: NoteField,
    value: string,
  ) {
    if (selectedConstructionPartId === "assembly") {
      setAssemblyNotes((notes) => updateNotes(notes, field, value));
      return;
    }

    if (selectedConstructionPartId) {
      setConstructionNotes((notesById) =>
        updateEntityNotes(
          notesById,
          selectedConstructionPartId,
          field,
          value,
        )
      );
    }
  }

  function toggleConstructionLock(partId: string) {
    if (!selectedBooth) {
      return;
    }

    const lockDefinition =
      partId === "assembly"
        ? selectedBooth
        : selectedBooth.constructionParts.find(
            (part) => part.id === partId
          );

    if (!lockDefinition || lockDefinition.systemLocked) {
      return;
    }

    setConstructionUserLocks((locks) => ({
      ...locks,
      [partId]: !(locks[partId] ?? lockDefinition.userLocked),
    }));
  }

  function toggleConstructionVisibility(partId: string) {
    if (!selectedBooth) {
      return;
    }

    const definition =
      partId === "assembly"
        ? selectedBooth
        : selectedBooth.constructionParts.find(
            (part) => part.id === partId
          );

    if (!definition) {
      return;
    }

    setConstructionVisibility((visibility) => ({
      ...visibility,
      [partId]: !(visibility[partId] ?? definition.visible),
    }));
  }

  function resetConfigurator() {
    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});

    setEditorMessage("");
  }

  /* ================================================= */
  /* RENDER                                           */
  /* ================================================= */

  return (
    <main
      className={
        isSidebarCollapsed
          ? "shell sidebarCollapsed"
          : "shell"
      }
    >
      {/* ================================================= */}
      {/* SIDEBAR                                         */}
      {/* ================================================= */}

      <AppSidebar
        collapsed={isSidebarCollapsed}
        onToggleCollapsed={() =>
          setIsSidebarCollapsed((collapsed) => !collapsed)
        }
        onStartNewProject={startNewProject}
      />

      {/* ================================================= */}
      {/* MAIN                                            */}
      {/* ================================================= */}

      <section className="main">
        {/* ================================================= */}
        {/* TOPBAR                                         */}
        {/* ================================================= */}

        <StepHeader currentStep={step} />

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

                  <label className="realizationField">
                    <span>Realizačka</span>
                    <select
                      value={realizationProfileId}
                      onChange={(event) =>
                        setRealizationProfileId(event.target.value)
                      }
                    >
                      {realizationProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Ovlivní pouze budoucí výrobní a exportní rozměry.
                    </small>
                  </label>

                  <div className="projectNotesDisclosure">
                    <button
                      type="button"
                      className="projectNotesToggle"
                      aria-expanded={isProjectNotesOpen}
                      onClick={() => setIsProjectNotesOpen((open) => !open)}
                    >
                      <span>Poznámky k projektu</span>

                      <span className="projectNotesToggleMeta">
                        {hasProjectNotes && (
                          <span className="projectNotesStatus">Vyplněno</span>
                        )}
                        <span
                          className={
                            isProjectNotesOpen
                              ? "projectNotesChevron open"
                              : "projectNotesChevron"
                          }
                          aria-hidden="true"
                        />
                      </span>
                    </button>

                    {isProjectNotesOpen && (
                      <NotesEditor
                        notes={projectNotes}
                        className="projectNotesEditor"
                        onChange={updateProjectNote}
                      />
                    )}
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
                                  handleVariantSelect(
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
                    <button
                      type="button"
                      className={
                        editorView === "2d"
                          ? "viewButton active"
                          : "viewButton"
                      }
                      aria-pressed={editorView === "2d"}
                      onClick={() => setEditorView("2d")}
                    >
                      2D
                    </button>

                    <button
                      type="button"
                      className={
                        editorView === "3d"
                          ? "viewButton active"
                          : "viewButton"
                      }
                      aria-pressed={editorView === "3d"}
                      onClick={() => setEditorView("3d")}
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

                <ComponentLibrary
                  onAddComponent={addComponent}
                />

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

                      <button
                        type="button"
                        className={
                          isHelpOpen
                            ? "helpToggleButton active"
                            : "helpToggleButton"
                        }
                        onClick={() =>
                          setIsHelpOpen((open) => !open)
                        }
                        aria-expanded={isHelpOpen}
                        aria-controls="configurator-help"
                      >
                        ? Ovládání
                      </button>

                      <ViewportToolbar
                        zoomPercent={boothViewport.zoomPercent}
                        onZoomOut={boothViewport.zoomOut}
                        onZoomIn={boothViewport.zoomIn}
                        onFit={boothViewport.fitToBooth}
                        onReset={boothViewport.resetZoom}
                      />
                    </div>
                  </div>

                  <ConfiguratorHelp
                    open={isHelpOpen}
                    onClose={() => setIsHelpOpen(false)}
                  />

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

                        <RotationNavigator
                          component={selectedPlacedComponent}
                          interactionLocked={selectedPlacedComponentLocked}
                          onQuickAngle={setSelectedQuickRotation}
                          onRotationChange={setSelectedRotation}
                          onModeChange={setSelectedRotationMode}
                        />

                        <div className="navigatorDivider" />

                        <div className="navigatorActions">
                          <button
                            disabled={selectedPlacedComponentLocked}
                            onClick={
                              duplicateSelectedComponent
                            }
                          >
                            Duplikovat
                          </button>

                          <button
                            className="deleteNavigatorButton"
                            disabled={selectedPlacedComponentLocked}
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
                    <div
                      ref={boothViewport.viewportRef}
                      className={
                        boothViewport.isPanning
                          ? "boothViewport panning"
                          : boothViewport.isSpacePressed
                            ? "boothViewport panReady"
                            : "boothViewport"
                      }
                      onPointerDown={handleViewportPointerDown}
                      onPointerMove={boothViewport.movePan}
                      onPointerUp={boothViewport.endPan}
                      onPointerCancel={boothViewport.endPan}
                    >
                      <div
                        className="viewportStage"
                        style={{
                          width: `${selectedBooth.widthMm * boothViewport.pixelsPerMm}px`,
                          height: `${selectedBooth.depthMm * boothViewport.pixelsPerMm}px`,
                          transform: `translate(${boothViewport.transform.pan.x}px, ${boothViewport.transform.pan.y}px) scale(${boothViewport.transform.zoom})`,
                        }}
                      >
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
                      className={
                        selectedConstructionPartId === "assembly"
                          ? "boothCanvas constructionSelected"
                          : "boothCanvas"
                      }
                      style={{
                        aspectRatio: `${selectedBooth.widthMm} / ${selectedBooth.depthMm}`,
                      }}
                    >
                      {/* CARPET */}

                      <div className="carpetLayer">
                        <span className="carpetLabel">
                          KOBEREC 2000 × 2000
                        </span>
                      </div>

                      {/* CAD-DERIVED CONSTRUCTION PLAN */}

                      <BoothCadPlanView
                        asset={selectedBoothMasterModel}
                        footprintWidthMm={selectedBooth.widthMm}
                        footprintDepthMm={selectedBooth.depthMm}
                        visible={constructionAssemblyVisible}
                        selected={selectedConstructionPartId !== null}
                      />

                      {/* COMPONENTS */}

                      {placedComponents.map(
                        (item) => {
                          if (!item.visible) {
                            return null;
                          }

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

                                isObjectLocked(item)
                                  ? "locked"
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
                              {item.frontDirectionDeg !== undefined && (
                                <i
                                  className="frontMarker"
                                  style={{
                                    transform: `translateX(-50%) rotate(${item.frontDirectionDeg}deg)`,
                                  }}
                                >
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
                      </div>
                    </div>

                  </div>

                  {editorView === "3d" && (
                    <div className="cadViewerMode">
                      <div className="cadModeHeader">
                        <div>
                          <span>3D / CAD MASTER</span>
                          <strong>{selectedBooth.name}</strong>
                        </div>
                        <span>REFERENČNÍ MODEL · BEZ EDITACE</span>
                      </div>

                      <BoothCadViewer
                        asset={selectedBoothMasterModel}
                        footprintWidthMm={selectedBooth.widthMm}
                        footprintDepthMm={selectedBooth.depthMm}
                        components={placedComponents}
                      />
                    </div>
                  )}
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
                    <span className="propertySectionTitle">
                      PROJEKT
                    </span>

                    <div className="propertyRow">
                      <span>Veletrh</span>
                      <strong>{selectedFair?.name || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Firma / vystavovatel</span>
                      <strong>{company || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Kontakt</span>
                      <strong>{contact || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Typ stánku</span>
                      <strong>{selectedBooth.name}</strong>
                    </div>

                    {selectedVariant && (
                      <div className="propertyRow">
                        <span>Varianta</span>
                        <strong>{selectedVariant.name}</strong>
                      </div>
                    )}

                    <div className="propertyRow">
                      <span>Ceník</span>
                      <strong>{selectedFair?.priceList || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Měna</span>
                      <strong>{currency}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Realizačka</span>
                      <strong>{selectedRealizationProfile?.name || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Cena konstrukce</span>
                      <strong>
                        {selectedBooth.pricing.mode === "fixed"
                          ? "Fixní typovka"
                          : "Dle konfigurace"}
                      </strong>
                    </div>

                    <NotesEditor
                      title="Poznámky projektu"
                      notes={projectNotes}
                      className="projectInspectorNotes inspectorNotes"
                      onChange={updateProjectNote}
                    />
                  </div>

                  <ScenePanel
                    booth={selectedBooth}
                    variant={selectedVariant}
                    components={placedComponents}
                    constructionUserLocks={constructionUserLocks}
                    constructionVisibility={constructionVisibility}
                    selectedComponentId={selectedComponentId}
                    selectedConstructionPartId={selectedConstructionPartId}
                    onSelectComponent={selectSceneComponent}
                    onSelectConstructionPart={selectConstructionPart}
                    onToggleComponentLock={toggleComponentLock}
                    onToggleConstructionLock={toggleConstructionLock}
                    onToggleComponentVisibility={toggleComponentVisibility}
                    onToggleConstructionVisibility={toggleConstructionVisibility}
                  />

                  <div className="propertySection">
                    <span className="propertySectionTitle">
                      VYBRANÝ OBJEKT
                    </span>

                    {selectedPlacedComponent ? (
                      <>
                        <div className="selectedComponentCard">
                          <span>Mobiliář</span>
                          <strong>{selectedPlacedComponent.name}</strong>
                        </div>

                        <div className="inspectorGroup">
                          <span className="inspectorGroupTitle">Pozice</span>
                          <div className="coordinateGrid">
                            <CoordinateInput
                              axis="X"
                              value={selectedPlacedComponent.xMm}
                              disabled={selectedPlacedComponentLocked}
                              onCommit={(value) =>
                                commitSelectedCoordinate("x", value)
                              }
                            />

                            <CoordinateInput
                              axis="Y"
                              value={selectedPlacedComponent.yMm}
                              disabled={selectedPlacedComponentLocked}
                              onCommit={(value) =>
                                commitSelectedCoordinate("y", value)
                              }
                            />
                          </div>
                        </div>

                        <div className="inspectorGroup">
                          <span className="inspectorGroupTitle">Rotace</span>
                          <div className="inspectorCompactRows">
                            <div>
                              <span>Úhel</span>
                              <strong>{selectedPlacedComponent.rotationDeg}°</strong>
                            </div>
                            <div>
                              <span>Režim</span>
                              <strong>
                                {selectedPlacedComponent.rotation.locked
                                  ? "Zamčená"
                                  : selectedPlacedComponent.rotationMode === "free"
                                    ? "Volná 360°"
                                    : `Rychlé po ${selectedPlacedComponent.rotation.snapStep}°`}
                              </strong>
                            </div>
                          </div>
                        </div>

                        <div className="inspectorGroup">
                          <div className="inspectorGroupHeader">
                            <span className="inspectorGroupTitle">Rozměry</span>
                            <span className="inspectorCapability">
                              {selectedPlacedComponent.resizable
                                ? "Upravitelné"
                                : "Pevné 1:1"}
                            </span>
                          </div>
                          <div className="inspectorDimensionGrid">
                            <div>
                              <span>Šířka</span>
                              <strong>{selectedPlacedComponent.widthMm} mm</strong>
                            </div>
                            <div>
                              <span>Hloubka</span>
                              <strong>{selectedPlacedComponent.depthMm} mm</strong>
                            </div>
                            {selectedPlacedComponent.heightMm !== undefined && (
                              <div>
                                <span>Výška</span>
                                <strong>{selectedPlacedComponent.heightMm} mm</strong>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="inspectorStatusRow">
                          <span>Zámek</span>
                          <strong>
                            {selectedPlacedComponent.systemLocked
                              ? "Systémový"
                              : selectedPlacedComponent.userLocked
                                ? "Uživatelský"
                                : "Odemčeno"}
                          </strong>
                        </div>

                        <NotesEditor
                          title="Poznámky"
                          notes={selectedPlacedComponent}
                          className="inspectorGroup inspectorNotes"
                          onChange={updateSelectedComponentNote}
                        />

                        <button
                          className="inspectorDelete"
                          disabled={selectedPlacedComponentLocked}
                          onClick={
                            deleteSelectedComponent
                          }
                        >
                          Smazat objekt
                        </button>
                      </>
                    ) : selectedConstructionName ? (
                      <>
                        <div className="selectedComponentCard">
                          <span>{selectedConstructionLayer}</span>
                          <strong>{selectedConstructionName}</strong>
                        </div>

                        <div className="propertyRow">
                          <span>Vrstva</span>
                          <strong>{selectedConstructionLayer}</strong>
                        </div>

                        {selectedConstructionPart && (
                          <div className="propertyRow">
                            <span>2D kolize</span>
                            <strong>
                              {selectedConstructionPart.collision2D
                                ? "Aktivní"
                                : "Bez kolize"}
                            </strong>
                          </div>
                        )}

                        <div className="propertyRow">
                          <span>Zámek</span>
                          <strong>
                            {selectedConstructionLocked
                              ? "Zamčeno"
                              : "Odemčeno"}
                          </strong>
                        </div>

                        {selectedConstructionNotes && (
                          <NotesEditor
                            title="Poznámky"
                            notes={selectedConstructionNotes}
                            className="inspectorGroup inspectorNotes"
                            onChange={updateSelectedConstructionNote}
                          />
                        )}
                      </>
                    ) : (
                      <p className="emptyInspector">
                        Vyber objekt v půdorysu nebo ve Scéně.
                      </p>
                    )}
                  </div>
                </aside>
              </div>

              {/* BOTTOM */}

              <PricingBar placedItemCount={placedComponents.length} />
            </div>
          )}
      </section>
    </main>
  );
}
