"use strict";(()=>{var e={};e.id=516,e.ids=[516],e.modules={145:e=>{e.exports=require("next/dist/compiled/next-server/pages-api.runtime.prod.js")},705:(e,i,n)=>{n.r(i),n.d(i,{config:()=>c,default:()=>s,routeModule:()=>l});var a={};n.r(a),n.d(a,{default:()=>handler});var o=n(802),t=n(44),r=n(249);async function handler(e,i){let n;if(i.setHeader("Access-Control-Allow-Origin",process.env.FRONTEND_ORIGIN||"*"),i.setHeader("Access-Control-Allow-Methods","POST, OPTIONS"),i.setHeader("Access-Control-Allow-Headers","Content-Type"),"OPTIONS"===e.method)return i.status(200).end();if("POST"!==e.method)return i.status(405).json({error:"M\xe9todo no permitido"});let a=process.env.ANTHROPIC_API_KEY;if(!a)return console.error("[LicitaIA] ANTHROPIC_API_KEY no configurada"),i.status(500).json({error:"Configuraci\xf3n del servidor incompleta"});let{base64PDF:o,tipo:t,empresa:r}=e.body||{};if(!o||"string"!=typeof o)return i.status(400).json({error:"Campo 'base64PDF' requerido (string base64)"});if(!t||!["viabilidad","clausulas","plazos","financiero"].includes(t))return i.status(400).json({error:"Campo 'tipo' inv\xe1lido. Valores: viabilidad, clausulas, plazos, financiero"});if(o.length>43e6)return i.status(413).json({error:"PDF supera el l\xedmite de 32MB"});let s=function(e,i){let n=i?`CONTEXTO DE EMPRESA:
Nombre: ${i.nombre} | Sector: ${i.sector} | Facturaci\xf3n: ${i.facturacion}
Empleados: ${i.empleados||"N/E"} | Certificaciones: ${i.certificaciones||"ninguna"}
Experiencia: ${i.experiencia||"no especificada"} | Capacidades: ${i.capacidades||"no especificadas"}
Historial: ${i.historial||"sin historial"}
INSTRUCCI\xd3N CR\xcdTICA: Cruza CADA requisito con las capacidades reales de esta empresa.`:"Sin perfil de empresa. An\xe1lisis general.";return`Analiza el documento enfoc\xe1ndote en ${({viabilidad:"viabilidad y conveniencia de presentarse a esta licitaci\xf3n",clausulas:"cl\xe1usulas clave y condiciones contractuales",plazos:"plazos, fechas cr\xedticas e hitos",financiero:"aspectos financieros, garant\xedas y penalidades"})[e]||"contenido general de la licitaci\xf3n"}.
${n}

Responde \xdaNICAMENTE con este JSON. Sin texto antes, sin texto despu\xe9s, sin backticks.
Cada "texto_original" DEBE ser cita textual exacta del documento.
Cada "fuente" DEBE indicar secci\xf3n, art\xedculo o p\xe1gina. Si no existe, usar exactamente: "Fuente no identificada claramente".
La "conclusion" DEBE terminar con exactamente una de estas frases:
  "Recomendaci\xf3n: Participar"
  "Recomendaci\xf3n: Participar con precauci\xf3n"  
  "Recomendaci\xf3n: No participar"

{
  "resumen": "string — resumen ejecutivo en 2-3 oraciones",
  "licitacion": {
    "nombre": "string",
    "organismo": "string",
    "objeto": "string",
    "monto": "string",
    "plazo_presentacion": "string",
    "plazo_ejecucion": "string"
  },
  "veredicto": "GO|NOGO|REVISAR",
  "score": number,
  "score_razon": "string",
  "requisitos": [
    {
      "requisito": "string",
      "estado": "OK|WARN|NOGO",
      "nota": "string",
      "fuente": "string",
      "texto_original": "string"
    }
  ],
  "riesgos": ["string"],
  "conclusion": "string"
}`}(t,r||null);try{n=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":a,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-sonnet-4-5",max_tokens:4096,system:`Eres LicitaIA, motor especializado en an\xe1lisis de licitaciones p\xfablicas y privadas.
REGLAS ABSOLUTAS — VIOLACI\xd3N = RESPUESTA INV\xc1LIDA:
1. Responde SOLO con JSON v\xe1lido. Cero texto fuera del JSON. Cero backticks.
2. Cada "texto_original" debe ser cita textual del documento, nunca par\xe1frasis.
3. Cada "fuente" debe indicar secci\xf3n o p\xe1gina. Si no existe, usar "Fuente no identificada claramente".
4. "riesgos" es array de strings simples, no objetos.
5. "conclusion" DEBE terminar con "Recomendaci\xf3n: Participar", "Recomendaci\xf3n: Participar con precauci\xf3n" o "Recomendaci\xf3n: No participar".
6. Nunca inventes datos que no est\xe9n en el documento.`,messages:[{role:"user",content:[{type:"document",source:{type:"base64",media_type:"application/pdf",data:o}},{type:"text",text:s}]}]})})}catch(e){return console.error("[LicitaIA] Error de red:",e.message),i.status(502).json({error:"Error de conexi\xf3n con el motor de IA. Intenta nuevamente."})}if(!n.ok){let e=await n.json().catch(()=>({})),a=e?.error?.message||`Error ${n.status}`;return console.error("[LicitaIA] Claude API error:",a),i.status(502).json({error:`Motor de IA: ${a}`})}let c=await n.json(),l=c?.content?.[0]?.text||"";if(!l)return i.status(502).json({error:"El motor de IA devolvi\xf3 una respuesta vac\xeda"});let d=function(e){try{let i=e.replace(/```json|```/g,"").trim(),n=i.indexOf("{"),a=i.lastIndexOf("}");if(-1===n||-1===a)return null;return JSON.parse(i.slice(n,a+1))}catch{return null}}(l);if(!(d&&"object"==typeof d&&"string"==typeof d.resumen&&d.resumen&&Array.isArray(d.requisitos)&&"string"==typeof d.conclusion&&d.conclusion))return console.warn("[LicitaIA] Schema inv\xe1lido, usando fallback. Raw:",l.slice(0,200)),i.status(200).json({data:{tipo:t,resumen:"No se pudo analizar de forma confiable. El motor de IA devolvi\xf3 un formato inesperado.",licitacion:{nombre:"—",organismo:"—",objeto:"—",monto:"—",plazo_presentacion:"—",plazo_ejecucion:"—"},veredicto:"REVISAR",score:null,score_razon:null,requisitos:[],riesgos:["El an\xe1lisis autom\xe1tico fall\xf3 — revisar manualmente el documento."],conclusion:"No fue posible completar el an\xe1lisis autom\xe1tico. Recomendaci\xf3n: Participar con precauci\xf3n"},warnings:["El motor de IA devolvi\xf3 un formato inesperado. Se us\xf3 resultado de seguridad."],valid:!1});let u=function(e,i){e.requisitos=(e.requisitos||[]).map(e=>({requisito:String(e.requisito||"Requisito sin descripci\xf3n"),estado:["OK","WARN","NOGO"].includes(e.estado)?e.estado:"WARN",nota:String(e.nota||""),fuente:String(e.fuente||"Fuente no identificada claramente"),texto_original:String(e.texto_original||"Fuente no identificada claramente")})),e.riesgos=(e.riesgos||[]).map(e=>"string"==typeof e?e:String(e.requisito||e.descripcion||JSON.stringify(e)));let n=e.requisitos.filter(e=>"OK"!==e.estado);if(n.length>0&&0===e.riesgos.length&&e.riesgos.push(`${n.length} requisito(s) requieren revisi\xf3n antes de presentar oferta.`),["GO","NOGO","REVISAR"].includes(e.veredicto)||(e.veredicto="REVISAR"),e.conclusion&&!e.conclusion.includes("Recomendaci\xf3n:")){let i="GO"===e.veredicto?"Participar":"NOGO"===e.veredicto?"No participar":"Participar con precauci\xf3n";e.conclusion=e.conclusion.trim()+` Recomendaci\xf3n: ${i}`}return e.tipo=i,e}(d,t);return i.status(200).json({data:u,warnings:[],valid:!0})}let s=(0,r.l)(a,"default"),c=(0,r.l)(a,"config"),l=new o.PagesAPIRouteModule({definition:{kind:t.x.PAGES_API,page:"/api/analyze",pathname:"/api/analyze",bundlePath:"",filename:""},userland:a})}};var i=require("../../webpack-api-runtime.js");i.C(e);var __webpack_exec__=e=>i(i.s=e),n=i.X(0,[222],()=>__webpack_exec__(705));module.exports=n})();