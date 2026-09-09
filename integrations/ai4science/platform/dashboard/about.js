// A visual explanation only: this module never calls the execution API.
const atlas = document.querySelector(".architecture-atlas");
const motion = document.querySelector("#motion-toggle");
const expand = document.querySelector("#map-expand");
const steps = [...document.querySelectorAll("[data-step]")];
const nodes = [...document.querySelectorAll("[data-node]")];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const stages = [
  [
    "SCIENTIFIC REASONING",
    "Start with a research question.",
    "A principal investigator can delegate literature review, hypotheses, experiment design, and critique to configured roles. The organization can change; the three layers describe responsibilities.",
  ],
  [
    "EXPERIMENT PLANNING",
    "Delegate intent, with clear limits.",
    "Each research branch creates its own experiment coordinator through Harness. Scientific objectives belong to the research layer; the coordinator plans supported actions within its delegated authority.",
  ],
  [
    "BOUNDED EXECUTION",
    "Let programs manage the operation.",
    "The execution layer validates input, reserves resources and budget, and records a stable operation identity before dispatch. Computation and simulated instruments are available; physical adapters remain future work.",
  ],
  [
    "OBSERVATION & COLLABORATION",
    "Observe facts. Coordinate explicitly.",
    "Coordinators receive progress and results. Cross-branch result references and replies preserve the original sender and require both live parents to authorize exact participants. A cancellation request does not prove a device has stopped.",
  ],
  [
    "EVIDENCE & PROVENANCE",
    "Bring the result back to its source.",
    "Durable operations, raw outputs, and source-linked artifacts form the implemented evidence foundation. A complete scientific claim graph and laboratory world model remain future directions.",
  ],
  [
    "SCIENTIFIC DECISIONS",
    "Close the loop with a better question.",
    "The research layer interprets evidence, revisits hypotheses, and chooses the next investigation. Critique, paper writing, and an autonomous scientific cycle describe the long-term vision, not a guaranteed capability today.",
  ],
];
const descriptions = {
  director: [
    "CEREBRUM",
    "A research organization, not one fixed Agent.",
    "The principal investigator represents research goals and synthesis. Roles, model choices, tools, participant limits and delegation depth come from configuration; Harness owns Agent execution.",
  ],
  literature: [
    "CEREBRUM",
    "Explore before committing to an experiment.",
    "Literature review and hypothesis generation are example research roles, not mandatory platform components. A scene can use one researcher or a larger delegated organization.",
  ],
  "research-a": [
    "REAL PARENT RELATIONSHIP",
    "Research A owns its coordinator.",
    "This branch delegates to coordinator A using the host lifecycle. Its exact live parent instance must authorize communication with coordinator B; a replaced parent does not inherit the old grant.",
  ],
  "research-b": [
    "REAL PARENT RELATIONSHIP",
    "Research B keeps an independent context.",
    "Research B creates its own coordinator. Cross-branch collaboration does not rewrite parent relationships or let a stale Agent object regain permission through a reused Session ID.",
  ],
  critic: [
    "SCIENTIFIC RESPONSIBILITY",
    "Separate observation from interpretation.",
    "Research roles can analyze data, critique reasoning, and prepare reports. The infrastructure verifies artifact references and integrity; it does not certify scientific truth or paper quality.",
  ],
  "mid-a": [
    "MIDBRAIN / BRANCH A",
    "Coordinate execution within delegated authority.",
    "An experiment coordinator can plan supported operations and observe results. Changing the scientific objective belongs to the research layer. General workflow compilation and automatic device substitution are future directions.",
  ],
  "mid-b": [
    "MIDBRAIN / BRANCH B",
    "Collaboration is a precise authorization.",
    "The existing extension supports constrained result references and associated replies between authorized participants. It is not an unrestricted Agent bus, shared inbox, or project-wide broadcast service.",
  ],
  control: [
    "DETERMINISTIC MANAGEMENT",
    "Wait and reconcile through programs.",
    "The existing execution engine owns durable requests, deduplication, resource reservations, budgets, cancellation observations and restart reconciliation. Unknown operations retain their reservations and are not blindly replayed.",
  ],
  compute: [
    "AVAILABLE PROVIDER",
    "A job can outlive the host process.",
    "The independently installed computation Provider runs a bounded external workload and records its own job identity. A new authorized controller can reconcile existing work; machine reboot continuation is not promised.",
  ],
  instrument: [
    "AVAILABLE REFERENCE",
    "Synthetic measurements, real execution records.",
    "The simulated instrument validates bounded inputs and produces recorded data. This verifies the software interface and management flow, not the reliability of any future physical instrument.",
  ],
  robot: [
    "FUTURE ADAPTERS",
    "Robotics belongs behind bounded capabilities.",
    "Navigation, manipulation and robot skills are architectural directions. Existing robot controllers should own trajectories, real-time control and physical interlocks. These integrations have not been implemented or validated here.",
  ],
  device: [
    "FUTURE ADAPTERS",
    "Connect an actual experimental workstation.",
    "Real instruments and IoT devices need explicit completion, cancellation, disconnection and reconciliation semantics. Each adapter must be validated against its actual device capabilities.",
  ],
  software: [
    "FUTURE DOMAIN ADAPTERS",
    "Extend digital scientific execution.",
    "Simulation, scientific software and other domain tools can be future Provider integrations. The public SDK and installed computation example are available today; arbitrary scientific applications are not already connected.",
  ],
};
let stage = 0;
let wanted = !reducedMotion.matches;
let inView = false;
let timer;
let enlarged = false;
const anchor = document.createComment("Architecture diagram location");
atlas.before(anchor);
const dialog = document.createElement("dialog");
dialog.className = "atlas-dialog";
dialog.setAttribute("aria-label", "Expanded research architecture");
document.body.append(dialog);
function describe([label, title, copy]) {
  document.querySelector("#detail-kicker").textContent = label;
  document.querySelector("#map-detail-title").textContent = title;
  document.querySelector("#map-detail-copy").textContent = copy;
}
function showStage(next) {
  stage = next;
  atlas.dataset.stage = String(stage);
  steps.forEach((button, i) =>
    button.setAttribute("aria-pressed", String(i === stage)),
  );
  atlas.querySelectorAll("[data-phases]").forEach((element) => {
    element.classList.toggle(
      "phase-active",
      element.dataset.phases.split(" ").includes(String(stage)),
    );
  });
  nodes.forEach((node) => node.setAttribute("aria-pressed", "false"));
  describe([`0${stage + 1} / ${stages[stage][0]}`, ...stages[stage].slice(1)]);
}
function syncMotion() {
  clearTimeout(timer);
  const playing =
    wanted &&
    !reducedMotion.matches &&
    !document.hidden &&
    (inView || enlarged);
  atlas.dataset.playing = String(playing);
  motion.setAttribute("aria-pressed", String(playing));
  motion.textContent = reducedMotion.matches
    ? "Reduced motion"
    : wanted
      ? "Pause animation"
      : "Play animation";
  motion.disabled = reducedMotion.matches;
  if (playing)
    timer = setTimeout(() => {
      showStage((stage + 1) % stages.length);
      syncMotion();
    }, 4200);
}
motion.addEventListener("click", () => {
  wanted = !wanted;
  syncMotion();
});
steps.forEach((button, i) => {
  button.disabled = false;
  button.addEventListener("click", () => {
    wanted = false;
    showStage(i);
    syncMotion();
  });
});
nodes.forEach((node) => {
  function select() {
    wanted = false;
    syncMotion();
    nodes.forEach((other) =>
      other.setAttribute("aria-pressed", String(other === node)),
    );
    describe(descriptions[node.dataset.node]);
  }
  node.setAttribute("aria-pressed", "false");
  node.addEventListener("click", select);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
});
function closeExpanded() {
  enlarged = false;
  anchor.after(atlas);
  dialog.close();
  document.body.classList.remove("atlas-expanded");
  expand.textContent = "Expand diagram ↗";
  expand.setAttribute("aria-expanded", "false");
  expand.focus({ preventScroll: true });
  syncMotion();
}
expand.disabled = false;
expand.addEventListener("click", () => {
  if (enlarged) return closeExpanded();
  enlarged = true;
  dialog.append(atlas);
  dialog.showModal();
  document.body.classList.add("atlas-expanded");
  expand.textContent = "Close expanded view ×";
  expand.setAttribute("aria-expanded", "true");
  expand.focus();
  syncMotion();
});
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeExpanded();
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) wanted = false;
  syncMotion();
});
document.addEventListener("visibilitychange", syncMotion);
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    syncMotion();
  }).observe(atlas);
} else {
  inView = true;
}
showStage(0);
syncMotion();
