// trace.js — 兼容入口（P3 内核分层后）
// 计算内核已拆到 core/（玻璃/面型/追迹/光束）与 analysis/（点列/光扇/像差/照度/波前）。
// 保留本文件作为统一转出口，旧调用点（main.js）无需改动。
export * from './core/glass.js?v=1.5.15';
export * from './core/surface.js?v=1.5.15';
export * from './core/raytrace.js?v=1.5.15';
export * from './core/beam.js?v=1.5.15';
export * from './analysis/spot.js?v=1.5.15';
export * from './analysis/fan.js?v=1.5.15';
export * from './analysis/aberr.js?v=1.5.15';
export * from './analysis/illum.js?v=1.5.15';
export * from './analysis/wavefront.js?v=1.5.15';
