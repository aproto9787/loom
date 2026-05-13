import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const slides = [
  {
    file: "01-heddle-improvement-targets.svg",
    title: "01. Heddle에 정확히 개선할 것",
    subtitle: "아까 자료에서 가져올 것은 운영 체계 자체가 아니라, Heddle 내부에 붙일 위험도 기반 게이트 구조입니다.",
    sections: [
      {
        type: "grid",
        title: "개선 대상 5곳",
        items: [
          ["Flow Schema", "riskTier, governancePack, GateRecord, RunManifest를 core schema로 추가합니다.", "packages/core"],
          ["Leader Policy", "요청을 받자마자 위험도와 필요한 gate를 판정하게 합니다.", "examples/leader-workers.yaml"],
          ["MCP Gate Tools", "worker 위임뿐 아니라 gate 기록, 승인 대기, rollback 확인을 tool로 남깁니다.", "packages/mcp"],
          ["Trace Store", "실행 이벤트뿐 아니라 gate 통과/차단 이유와 run manifest를 저장합니다.", "apps/server"],
          ["Studio View", "Risk badge, gate timeline, worker report, rollback memo를 한 화면에 보여줍니다.", "apps/studio"],
        ],
      },
      {
        type: "flow",
        title: "개선 방향",
        items: ["요청", "위험도 판정", "Gate 선택", "Worker 실행", "Trace + Studio"],
      },
      {
        type: "callout",
        title: "핵심 판단",
        body: "Heddle을 무거운 enterprise SDLC로 바꾸지 않습니다. 빠른 로컬 실행은 유지하고, 위험 작업에서만 필요한 운영 체계를 강제합니다.",
      },
    ],
  },
  {
    file: "02-risk-tier-decision.svg",
    title: "02. Risk Tier 판정",
    subtitle: "leader가 작업 시작 전에 위험도를 고정하면, 이후 필요한 worker와 gate가 흔들리지 않습니다.",
    sections: [
      {
        type: "tier",
        title: "Tier A: Quick / Local",
        tone: "green",
        lines: [
          "대상: 단순 질문, 짧은 조사, 단일 파일 문서 수정, read-only 명령",
          "Gate: intent-summary, completion-note",
          "기본값: direct-first, worker 없음",
          "목표: 속도 유지",
        ],
      },
      {
        type: "tier",
        title: "Tier B: Code / Schema",
        tone: "amber",
        lines: [
          "대상: 다파일 코드 변경, API route, schema, MCP tool, CLI behavior",
          "Gate: acceptance, contract, forbidden-pattern-check, reviewer",
          "Worker: impl, reviewer, 필요 시 advocate",
          "목표: 회귀와 범위 이탈 차단",
        ],
      },
      {
        type: "tier",
        title: "Tier C: Side Effect",
        tone: "red",
        lines: [
          "대상: 삭제, 배포, 계정 변경, 서비스 재시작, 데이터 변경, 실거래",
          "Gate: rollback-memo, explicit-approval, dispatch-gate, final-state-check",
          "Worker: 준비 작업만 가능, 실제 실행은 승인 후",
          "목표: 되돌리기 어려운 사고 차단",
        ],
      },
      {
        type: "tier",
        title: "Tier D: Enterprise / Release",
        tone: "purple",
        lines: [
          "대상: 공개 release, 보안/결제/권한, multi-phase, 여러 repo 변경",
          "Gate: spec, traceability, phase loop, risk register, reviewer, advocate",
          "Worker: analyst, impl, reviewer, user-advocate 분리",
          "목표: 큰 변경의 추적성과 승인 경계 확보",
        ],
      },
    ],
  },
  {
    file: "03-governance-packs.svg",
    title: "03. Governance Pack 매핑",
    subtitle: "48개 체계 중 필요한 것만 risk tier에 매핑합니다. 모든 작업에 전부 켜지 않습니다.",
    sections: [
      {
        type: "matrix",
        title: "기본 매핑",
        headers: ["Tier", "필수 Gate", "자동 산출물", "기본 OFF"],
        rows: [
          ["A.quick", "Intent summary", "Completion note", "Spec DAG, reviewer"],
          ["B.code", "DoD, API contract, forbidden pattern, reviewer", "GateRecord, REPORT", "Compliance, DR"],
          ["C.side_effect", "Rollback memo, explicit approval, dispatch gate", "Approval record, final-state evidence", "자동 실행"],
          ["D.enterprise", "Spec, traceability, phase PASS, risk register", "RunManifest, release note, postmortem", "무제한 scope"],
        ],
      },
      {
        type: "cards",
        title: "Heddle에 바로 가져올 체계",
        items: [
          ["DoD", "완료 기준을 먼저 고정"],
          ["API Contract", "입력/출력/side effect 고정"],
          ["Dispatch Gate", "왜 worker가 필요한지 기록"],
          ["Run Manifest", "요청, tier, gate, worker를 한 묶음으로 저장"],
          ["Rollback Memo", "위험 작업의 복구 경로 확보"],
          ["Learning Memory", "실패 원인과 절차를 재사용"],
        ],
      },
    ],
  },
  {
    file: "04-improved-execution-flow.svg",
    title: "04. 개선된 실행 흐름",
    subtitle: "leader가 위험도를 판정하고, 필요한 worker와 gate만 실행한 뒤, 결과가 trace와 Studio에 남습니다.",
    sections: [
      {
        type: "pipeline",
        title: "실행 파이프라인",
        items: [
          ["1", "User Request", "짧은 지시를 목표로 정규화"],
          ["2", "Risk Classifier", "A/B/C/D tier 결정"],
          ["3", "Contract Intake", "DoD, API contract, side effect 확인"],
          ["4", "Leader Orchestration", "직접 처리, worker, debate, phase loop 선택"],
          ["5", "MCP Boundary", "heddle_delegate_many, status, report, cancel"],
          ["6", "Gate Loop", "reviewer/advocate/approval/rollback 확인"],
          ["7", "Trace + Studio", "runManifest, gateRecord, REPORT 표시"],
        ],
      },
      {
        type: "callout",
        title: "실패 처리",
        body: "reviewer FAIL은 codex-fix로, user-advocate FAIL은 목표/결과 수정으로, 승인 누락은 실행 중지로 처리합니다. running 상태는 절대 완료로 보지 않습니다.",
      },
    ],
  },
  {
    file: "05-benefits-and-outcomes.svg",
    title: "05. 개선했을 때의 장점",
    subtitle: "문서가 많아지는 게 아니라, 위험 작업에서만 필요한 검증과 흔적이 자동으로 붙습니다.",
    sections: [
      {
        type: "benefits",
        title: "사용자 체감 장점",
        items: [
          ["빠른 작업은 빠르게", "Tier A는 지금처럼 direct-first로 끝납니다."],
          ["위험 작업은 멈춤", "승인, rollback, final-state 없이 side effect가 실행되지 않습니다."],
          ["위임이 보임", "worker 소유 범위와 REPORT가 run 안에 남습니다."],
          ["리뷰 기준 고정", "reviewer가 acceptance와 contract 기준으로 봅니다."],
          ["재현 가능", "runManifest와 gateRecord가 trace DB에 남습니다."],
          ["학습 가능", "실패 원인과 해결 절차가 memento로 재사용됩니다."],
        ],
      },
      {
        type: "beforeAfter",
        title: "Before / After",
        before: [
          "위험도 판단이 prompt 안에만 있음",
          "gate 통과 이유가 흩어짐",
          "Studio가 run log 중심",
          "side effect 승인 경계가 수동",
        ],
        after: [
          "riskTier가 구조화됨",
          "GateRecord와 RunManifest가 남음",
          "Studio에서 gate timeline 확인",
          "승인/rollback 없이 위험 실행 불가",
        ],
      },
    ],
  },
];

const palette = {
  green: ["#edf8ef", "#57aa71"],
  amber: ["#fff4dd", "#e1a037"],
  red: ["#fff0f0", "#dc6a6a"],
  purple: ["#f3ecfb", "#9a63d7"],
  blue: ["#e7f0ff", "#6b9cf2"],
  cyan: ["#e9fbf8", "#31a897"],
};

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textLines(lines, x, y, cls = "body", gap = 26) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * gap}" class="${cls}">${esc(line)}</text>`).join("\n");
}

function rect(x, y, w, h, tone = "soft", rx = 18) {
  if (palette[tone]) {
    const [fill, stroke] = palette[tone];
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.7"/>`;
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" class="${tone}"/>`;
}

function renderSection(section, index) {
  if (section.type === "grid") {
    const startX = 96;
    const startY = 230;
    const cardW = 330;
    const cardH = 126;
    const gap = 28;
    const items = section.items.map((item, i) => {
      const x = startX + (i % 3) * (cardW + gap);
      const y = startY + Math.floor(i / 3) * (cardH + 30);
      return `
        ${rect(x, y, cardW, cardH, i % 2 === 0 ? "blue" : "purple")}
        <text x="${x + 26}" y="${y + 38}" class="label">${esc(item[0])}</text>
        ${textLines(wrap(item[1], 34), x + 26, y + 68, "body", 22)}
        <text x="${x + 26}" y="${y + 108}" class="mono">${esc(item[2])}</text>
      `;
    }).join("\n");
    return `<text x="96" y="200" class="section">${esc(section.title)}</text>${items}`;
  }

  if (section.type === "flow") {
    const y = 566;
    const w = 220;
    const gap = 36;
    const nodes = section.items.map((item, i) => {
      const x = 96 + i * (w + gap);
      const arrow = i < section.items.length - 1 ? `<path class="arrow" d="M${x + w} ${y + 48} H${x + w + gap - 8}"/>` : "";
      return `${rect(x, y, w, 96, i % 2 ? "amber" : "green")}<text x="${x + 28}" y="${y + 58}" class="label">${esc(item)}</text>${arrow}`;
    }).join("\n");
    return `<text x="96" y="${y - 32}" class="section">${esc(section.title)}</text>${nodes}`;
  }

  if (section.type === "callout") {
    const y = index > 0 ? 760 : 702;
    return `
      ${rect(96, y, 1408, 112, "cyan")}
      <text x="128" y="${y + 42}" class="label">${esc(section.title)}</text>
      ${textLines(wrap(section.body, 92), 128, y + 72, "body", 24)}
    `;
  }

  if (section.type === "tier") {
    const x = index % 2 === 0 ? 96 : 820;
    const y = 230 + Math.floor(index / 2) * 270;
    return `
      ${rect(x, y, 684, 226, section.tone)}
      <text x="${x + 32}" y="${y + 46}" class="label">${esc(section.title)}</text>
      ${textLines(section.lines, x + 32, y + 84, "body", 31)}
    `;
  }

  if (section.type === "matrix") {
    const x = 96;
    const y = 232;
    const col = [130, 450, 360, 350];
    let out = `<text x="${x}" y="202" class="section">${esc(section.title)}</text>`;
    out += `${rect(x, y, 1408, 70, "dark", 14)}`;
    let cx = x + 24;
    section.headers.forEach((header, i) => {
      out += `<text x="${cx}" y="${y + 44}" class="darkText">${esc(header)}</text>`;
      cx += col[i];
    });
    section.rows.forEach((row, r) => {
      const ry = y + 86 + r * 86;
      out += `${rect(x, ry, 1408, 70, r % 2 ? "soft" : "blue", 14)}`;
      let tx = x + 24;
      row.forEach((cell, c) => {
        out += textLines(wrap(cell, c === 1 ? 42 : 28), tx, ry + 30, c === 0 ? "mono" : "body", 21);
        tx += col[c];
      });
    });
    return out;
  }

  if (section.type === "cards") {
    const startX = 96;
    const y = 702;
    const cardW = 214;
    const gap = 24;
    let out = `<text x="${startX}" y="${y - 32}" class="section">${esc(section.title)}</text>`;
    section.items.forEach((item, i) => {
      const x = startX + i * (cardW + gap);
      out += `${rect(x, y, cardW, 122, i % 2 ? "green" : "cyan")}`;
      out += `<text x="${x + 22}" y="${y + 42}" class="label">${esc(item[0])}</text>`;
      out += textLines(wrap(item[1], 20), x + 22, y + 72, "body", 22);
    });
    return out;
  }

  if (section.type === "pipeline") {
    const x = 96;
    const y = 230;
    let out = `<text x="${x}" y="202" class="section">${esc(section.title)}</text>`;
    section.items.forEach((item, i) => {
      const rowY = y + i * 82;
      out += `${rect(x, rowY, 1408, 58, i % 2 ? "soft" : "blue", 14)}`;
      out += `<rect x="${x + 22}" y="${rowY + 13}" width="32" height="32" rx="10" fill="#172033"/>`;
      out += `<text x="${x + 34}" y="${rowY + 35}" class="numText">${esc(item[0])}</text>`;
      out += `<text x="${x + 76}" y="${rowY + 36}" class="label">${esc(item[1])}</text>`;
      out += `<text x="${x + 394}" y="${rowY + 36}" class="body">${esc(item[2])}</text>`;
    });
    return out;
  }

  if (section.type === "benefits") {
    const startX = 96;
    const startY = 230;
    const cardW = 444;
    const cardH = 118;
    const gapX = 38;
    const gapY = 30;
    let out = `<text x="${startX}" y="200" class="section">${esc(section.title)}</text>`;
    section.items.forEach((item, i) => {
      const x = startX + (i % 3) * (cardW + gapX);
      const y = startY + Math.floor(i / 3) * (cardH + gapY);
      out += `${rect(x, y, cardW, cardH, i % 2 ? "green" : "cyan")}`;
      out += `<text x="${x + 28}" y="${y + 42}" class="label">${esc(item[0])}</text>`;
      out += textLines(wrap(item[1], 42), x + 28, y + 72, "body", 22);
    });
    return out;
  }

  if (section.type === "beforeAfter") {
    const y = 620;
    let out = `<text x="96" y="${y - 36}" class="section">${esc(section.title)}</text>`;
    out += `${rect(96, y, 660, 250, "red")}`;
    out += `<text x="132" y="${y + 44}" class="label">Before</text>`;
    out += textLines(section.before.map((v) => `- ${v}`), 132, y + 84, "body", 32);
    out += `${rect(844, y, 660, 250, "green")}`;
    out += `<text x="880" y="${y + 44}" class="label">After</text>`;
    out += textLines(section.after.map((v) => `- ${v}`), 880, y + 84, "body", 32);
    return out;
  }

  return "";
}

function wrap(value, max) {
  const words = String(value).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function renderSlide(slide) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="960" viewBox="0 0 1600 960" role="img" aria-label="${esc(slide.title)}">
  <defs>
    <style>
      .bg { fill: #f4f6fa; }
      .frame { fill: #fff; stroke: #d9e2ee; stroke-width: 1.5; rx: 30; }
      .title { font: 850 42px "Inter", "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif; fill: #151f31; letter-spacing: 0; }
      .subtitle { font: 520 19px "Inter", "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif; fill: #5b687b; letter-spacing: 0; }
      .section { font: 850 24px "Inter", "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif; fill: #172033; letter-spacing: 0; }
      .label { font: 780 18px "Inter", "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif; fill: #172033; letter-spacing: 0; }
      .body { font: 520 15.5px "Inter", "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif; fill: #455267; letter-spacing: 0; }
      .mono { font: 720 13px "JetBrains Mono", "SFMono-Regular", Consolas, monospace; fill: #374359; letter-spacing: 0; }
      .dark { fill: #172033; stroke: #172033; stroke-width: 1.2; }
      .darkText { font: 830 14px "Inter", "Noto Sans KR", Arial, sans-serif; fill: #fff; letter-spacing: 0; }
      .soft { fill: #f2f6fb; stroke: #dce5ef; stroke-width: 1.2; }
      .numText { font: 850 14px "Inter", "Noto Sans KR", Arial, sans-serif; fill: #fff; letter-spacing: 0; }
      .arrow { fill: none; stroke: #65748a; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; marker-end: url(#arrowHead); }
    </style>
    <marker id="arrowHead" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
      <path d="M2 2 L10 6 L2 10 Z" fill="#65748a"/>
    </marker>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#1e2a44" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect class="bg" width="1600" height="960"/>
  <rect x="44" y="38" width="1512" height="884" class="frame" filter="url(#shadow)"/>
  <text x="82" y="104" class="title">${esc(slide.title)}</text>
  ${textLines(wrap(slide.subtitle, 92), 82, 142, "subtitle", 26)}
  ${slide.sections.map(renderSection).join("\n")}
  <text x="82" y="894" class="mono">heddle-doctor / risk-tiered governance image set</text>
</svg>`;
}

mkdirSync(__dirname, { recursive: true });

for (const slide of slides) {
  writeFileSync(join(__dirname, slide.file), renderSlide(slide), "utf8");
}

console.log(`generated ${slides.length} svg files in ${__dirname}`);
