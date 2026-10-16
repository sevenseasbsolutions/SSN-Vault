/**
 * Chart.js wrappers.
 *
 * Every chart carries a basis label, and clicking a segment calls `onDrill`
 * with enough information for the caller to open the matching filtered
 * records. Colours are semantic and read from the active theme.
 */

import { el } from './ui.js';
import { money, moneyShort, monthLabel } from './format.js';

const registry = new Set();

const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function palette() {
  return {
    income: cssVar('--income', '#34d399'),
    expense: cssVar('--expense', '#fb923c'),
    reserve: cssVar('--reserve', '#60a5fa'),
    distribution: cssVar('--distribution', '#a78bfa'),
    payment: cssVar('--payment', '#22d3ee'),
    outstanding: cssVar('--outstanding', '#fbbf24'),
    text: cssVar('--text-muted', '#9aa2ad'),
    grid: cssVar('--border', '#23272e'),
    surface: cssVar('--surface', '#131519'),
  };
}

/** Qualitative series colours for "by sub-company" / "by SSN" breakdowns. */
export const seriesColours = () => {
  const p = palette();
  return [p.income, p.reserve, p.distribution, p.expense, p.payment, p.outstanding,
    '#f472b6', '#4ade80', '#38bdf8', '#c084fc', '#facc15', '#2dd4bf'];
};

export function destroyCharts() {
  for (const chart of registry) { try { chart.destroy(); } catch { /* already gone */ } }
  registry.clear();
}

function baseOptions({ money: isMoney = true, stacked = false, onDrill, labels } = {}) {
  const p = palette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    onClick: onDrill
      ? (event, elements) => {
        if (!elements.length) return;
        const { index, datasetIndex } = elements[0];
        onDrill({ index, datasetIndex, label: labels?.[index] });
      }
      : undefined,
    onHover: onDrill
      ? (event, elements) => {
        event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
      }
      : undefined,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: p.text, boxWidth: 9, boxHeight: 9, usePointStyle: true,
          pointStyle: 'circle', padding: 14, font: { size: 11 },
        },
      },
      tooltip: {
        backgroundColor: p.surface,
        borderColor: p.grid,
        borderWidth: 1,
        titleColor: cssVar('--text', '#e8eaed'),
        bodyColor: p.text,
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        callbacks: {
          label: (ctx) => {
            const value = ctx.parsed.y ?? ctx.parsed;
            return ` ${ctx.dataset.label ?? ctx.label}: ${isMoney ? money(value) : value}`;
          },
        },
      },
    },
    scales: {
      x: {
        stacked,
        grid: { display: false },
        border: { color: p.grid },
        ticks: { color: p.text, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        stacked,
        beginAtZero: true,
        grid: { color: p.grid, drawTicks: false },
        border: { display: false },
        ticks: {
          color: p.text, font: { size: 11 }, padding: 8,
          callback: (value) => (isMoney ? moneyShort(value) : value),
        },
      },
    },
  };
}

function mount(container, config) {
  if (!window.Chart) {
    container.append(el('p', { class: 'muted', text: 'Charts are unavailable (Chart.js did not load).' }));
    return null;
  }
  const canvas = el('canvas');
  container.append(canvas);
  const chart = new window.Chart(canvas, config);
  registry.add(chart);
  return chart;
}

export function chartBox({ title, basis, height = 260, build }) {
  const box = el('div', { class: 'chart-box', style: `height:${height}px` });
  const section = el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: title }),
      el('span', { class: 'spacer' }),
      basis ? el('span', { class: 'basis-tag' }, ['◴ ', basis]) : null,
    ]),
    el('div', { class: 'card-body' }, box),
  ]);
  queueMicrotask(() => build(box));
  return section;
}

/* --------------------------------------------------------------- builders -- */

export function barChart(container, { labels, datasets, stacked = false, onDrill, money: isMoney = true }) {
  return mount(container, {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map((set) => ({
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 40,
        ...set,
      })),
    },
    options: baseOptions({ money: isMoney, stacked, onDrill, labels }),
  });
}

export function lineChart(container, { labels, datasets, onDrill, money: isMoney = true }) {
  return mount(container, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((set) => ({
        tension: 0.32,
        borderWidth: 2,
        pointRadius: 2.5,
        pointHoverRadius: 5,
        fill: set.fill ?? false,
        ...set,
      })),
    },
    options: baseOptions({ money: isMoney, onDrill, labels }),
  });
}

export function doughnutChart(container, { labels, values, onDrill }) {
  const p = palette();
  return mount(container, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: seriesColours(),
        borderColor: p.surface,
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      onClick: onDrill
        ? (event, elements) => {
          if (elements.length) onDrill({ index: elements[0].index, label: labels[elements[0].index] });
        }
        : undefined,
      onHover: onDrill
        ? (event, elements) => {
          event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        }
        : undefined,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: p.text, boxWidth: 9, boxHeight: 9, usePointStyle: true,
            pointStyle: 'circle', padding: 11, font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: p.surface, borderColor: p.grid, borderWidth: 1,
          titleColor: cssVar('--text', '#e8eaed'), bodyColor: p.text,
          padding: 10, cornerRadius: 8,
          callbacks: { label: (ctx) => ` ${ctx.label}: ${money(ctx.parsed)}` },
        },
      },
    },
  });
}

export const monthLabels = (rows) => rows.map((row) => monthLabel(row.month));
