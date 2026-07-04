// 🆕 2026-07-04 registry 三步改造第③步:本文件降级为纯 barrel(连接/schema/函数全在 shared/db.ts)
// 8 个调用方 import 路径不变 · 签名不变(计划书 §3 数据一致性原则 2)
export { db, upsertSource, updateProbe, listSources, countSources, type SourceRow } from '../../shared/db.js';
