(function(){
  const STATUS_LABELS = {
    positivo: 'Concluído',
    andamento: 'Em andamento',
    negativo: 'Atenção',
    neutro: 'Retificado'
  };
  const STATUS_COLORS = { positivo:'--pos', andamento:'--andamento', negativo:'--neg', neutro:'--neutro' };

  // Todo PER/DCOMP é, na origem, um de dois tipos: o que CONSTITUI o crédito (não
  // referencia nenhum outro PER/DCOMP) ou o que USA o saldo de um crédito já
  // constituído (referencia o número do "PER/DCOMP Inicial" que o originou).
  // Essa classificação só é possível para números com PDF importado.
  const DOCTYPE_LABELS = { credito:'Crédito', compensacao:'Compensação' };
  const DOCTYPE_COLORS = { credito:'--brass', compensacao:'--neutro' };

  // Sugestões fixas de "Tipo de crédito" pra aba "Controle de crédito" — somadas (sem
  // duplicar) aos tipos já vistos nos PDFs importados deste cliente. O campo continua
  // sendo texto livre; isso é só a lista de sugestões do <datalist>.
  const CREDITO_TIPO_SUGESTOES_FIXAS = [
    'Saldo Negativo de IRPJ',
    'Saldo Negativo de CSLL',
    'Pagamento Indevido ou a Maior – IRPJ',
    'Pagamento Indevido ou a Maior – CSLL',
    'Pagamento Indevido ou a Maior – PIS',
    'Pagamento Indevido ou a Maior – COFINS',
    'Crédito de IPI',
    'Crédito de PIS/COFINS',
    'Crédito de Retenção de IR',
    'Crédito de Retenção de CSLL',
    'Crédito de Retenção de PIS/COFINS/CSLL',
    'Ressarcimento de IPI',
    'Ressarcimento de PIS/COFINS',
    'Crédito Judicial',
    'Crédito de Prejuízo Fiscal – IRPJ',
    'Crédito de Base Negativa – CSLL',
    'Outros Créditos'
  ];

  let state = {
    clients: [],       // [{slug, name, cnpj, count}]
    selectedSlug: null,
    records: [],        // records of selected client
    pdfData: {},         // numero -> extracted PDF fields, for selected client
    filters: { q:'', credito:'', documento:'', situacao:'', natureza:'', from:'', to:'' },
    compFilters: { busca:'', from:'', to:'' },
    lancFilters: { from:'', to:'', busca:'' }, // filtro por Data de Criação e por Nº PER/DCOMP, na aba Lançamentos contábeis
    lancOverrides: { debito:{}, credito:{}, debitoExtra:{}, creditoExtra:{}, complemento:{}, codHistorico:{}, iniciaLote:{}, matrizFilial:{}, centroCustoDebito:{}, centroCustoCredito:{} }, // correções manuais do usuário nos lançamentos, por cliente (ver saveLancOverrides)
    lancMsg: null,       // {text, kind} — resultado do download do .txt
    compReportMsg: null, // {text, kind} — resultado da geração do relatório em PDF
    creditoEntries: [],  // lançamentos manuais de crédito da aba "Controle de crédito", do cliente selecionado
    activeTab: 'registros',   // 'registros' | 'controle' | 'semorigem' | 'lancamentos' | 'controlecredito'
    uploadMsg: null,     // {text, kind}
    modalNumero: null,
    modalRoot: null,
    modalClient: null,   // { slug: null|string, notice?: string, focus?: string } enquanto o cadastro/edição de cliente está aberto
    modalImportFails: null, // { items:[{label,reason,cnpj}], expected, contextLabel } — itens rejeitados na importação (CNPJ divergente ou PDF que não é um PER/DCOMP)
    modalCredito: null,  // { id: null|string, notice?: string } enquanto o cadastro/edição de crédito manual está aberto
    // { title, message, confirmLabel, onConfirm } — modal de confirmação genérico (substitui
    // window.confirm(), que não abre dentro do iframe sandboxed em que este Artifact roda —
    // clicar em "Remover" com confirm() nativo simplesmente não fazia nada, silenciosamente).
    modalConfirm: null,
    dbAvailable: null,   // null = ainda não sabemos; true/false depois da 1ª tentativa de conectar ao banco (ver loadClients)
    loading: false
  };

  if (window.pdfjsLib){
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  function slugify(str){
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'cliente';
  }
  function normalize(str){
    return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  }

  // CNPJ: d\u00edgitos puros para compara\u00e7\u00e3o/armazenamento, m\u00e1scara s\u00f3 para exibi\u00e7\u00e3o/digita\u00e7\u00e3o.
  function onlyDigits(v){ return String(v||'').replace(/\D/g,''); }
  function formatCnpj(v){
    const d = onlyDigits(v).slice(0,14);
    if (d.length > 12) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, (m,a,b,c,e,f) => `${a}.${b}.${c}/${e}` + (f ? `-${f}` : ''));
    if (d.length > 8) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{0,4})/, (m,a,b,c,e) => `${a}.${b}.${c}` + (e ? `/${e}` : ''));
    if (d.length > 5) return d.replace(/^(\d{2})(\d{3})(\d{0,3})/, (m,a,b,c) => `${a}.${b}` + (c ? `.${c}` : ''));
    if (d.length > 2) return d.replace(/^(\d{2})(\d{0,3})/, (m,a,b) => `${a}` + (b ? `.${b}` : ''));
    return d;
  }
  // Valida\u00e7\u00e3o por d\u00edgito verificador (algoritmo oficial da Receita Federal).
  function isValidCnpj(digits){
    if (!/^\d{14}$/.test(digits)) return false;
    if (/^(\d)\1{13}$/.test(digits)) return false;
    const calcDigit = (base) => {
      const weights = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
      let sum = 0;
      for (let i=0;i<base.length;i++) sum += Number(base[i]) * weights[i];
      const r = sum % 11;
      return r < 2 ? 0 : 11 - r;
    };
    const d1 = calcDigit(digits.slice(0,12));
    const d2 = calcDigit(digits.slice(0,12) + d1);
    return digits === digits.slice(0,12) + String(d1) + String(d2);
  }

  // Filtro "De"/"Até" por data: usamos um <input type="text"> com máscara própria em vez
  // do <input type="date"> nativo. O campo nativo tem um comportamento de digitação por
  // segmentos (dia/mês/ano) controlado pelo navegador, não pela página — quando o segmento
  // do ano já tem um valor completo, digitar de novo faz o navegador deslocar os dígitos em
  // vez de simplesmente preenchê-los da esquerda pra direita, o que aparenta estar "invertido".
  // Com máscara própria a digitação é sempre estritamente da esquerda pra direita.
  function formatDateBr(v){
    const d = onlyDigits(v).slice(0,8);
    if (d.length > 4) return d.replace(/^(\d{2})(\d{2})(\d{0,4})/, (m,a,b,c) => `${a}/${b}` + (c ? `/${c}` : ''));
    if (d.length > 2) return d.replace(/^(\d{2})(\d{0,2})/, (m,a,b) => `${a}` + (b ? `/${b}` : ''));
    return d;
  }
  // Converte "dd/mm/aaaa" (o que fica guardado no filtro) para "aaaa-mm-dd" (o formato
  // usado em r.dataIso) — retorna '' enquanto a data não estiver completa/válida, o que
  // faz o filtro simplesmente não se aplicar ainda.
  function dateBrToIso(v){
    const m = String(v||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return '';
    const [_, dd, mm, yyyy] = m;
    const d = new Date(Number(yyyy), Number(mm)-1, Number(dd));
    if (isNaN(d) || d.getDate() !== Number(dd) || d.getMonth() !== Number(mm)-1) return '';
    return yyyy + '-' + mm + '-' + dd;
  }
  // Filtro "De"/"Até" por competência (mês/ano, ex.: 07/2026) — mesma lógica de máscara
  // do filtro por data completa acima, só que com 2 dígitos de mês + 4 de ano.
  function formatMonthYear(v){
    const d = onlyDigits(v).slice(0,6);
    if (d.length > 2) return d.replace(/^(\d{2})(\d{0,4})/, (m,a,b) => `${a}` + (b ? `/${b}` : ''));
    return d;
  }
  // Máscara "Nº Trimestre/AAAA" pro Período do crédito quando a Periodicidade calculada
  // (ver creditoPeriodicidade) é "Trimestral" — só aceita 1 a 4 no dígito do trimestre,
  // já que não existe "5º Trimestre".
  function formatQuarterYear(v){
    const d = onlyDigits(v).slice(0,5);
    if (!d) return '';
    let q = Number(d[0]);
    if (q < 1) q = 1;
    if (q > 4) q = 4;
    const rest = d.slice(1);
    return `${q}º Trimestre` + (rest ? `/${rest}` : '');
  }
  // Só o ano (4 dígitos) pro Período do crédito quando a Periodicidade calculada é "Anual".
  function formatYearOnly(v){
    return onlyDigits(v).slice(0,4);
  }
  // Converte "mm/aaaa" pra uma chave numérica comparável (ano*12+mês) — retorna null
  // enquanto o mês/ano não estiver completo/válido, o que faz o filtro não se aplicar ainda.
  function monthYearToKey(v){
    const m = String(v||'').match(/^(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const mm = Number(m[1]), yyyy = Number(m[2]);
    if (mm < 1 || mm > 12) return null;
    return yyyy * 12 + (mm - 1);
  }
  // Máscara de valor em reais pra digitação (campo "Valor original" da aba Controle de
  // crédito) — trata os dígitos digitados como centavos, igual à máscara de um caixa
  // eletrônico, e formata no padrão brasileiro (1.234,56) enquanto a pessoa digita.
  function formatCurrencyInput(v){
    const digits = onlyDigits(v).replace(/^0+(?=\d)/, '').slice(0, 15);
    const n = digits ? parseInt(digits, 10) : 0;
    return (n / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Converte o texto mascarado de volta pra número — null quando o campo está vazio,
  // pra distinguir "não informado" de "R$ 0,00" de propósito.
  function currencyInputToNumber(v){
    const digits = onlyDigits(v);
    if (!digits) return null;
    return parseInt(digits, 10) / 100;
  }
  function statusCategory(situacao){
    const t = normalize(situacao || '');
    if (t.includes('homolog') || t.includes('deferid') || t.includes('concluid')) return 'positivo';
    if (t.includes('analise') || t.includes('despacho')) return 'andamento';
    if (t.includes('cancelad') || t.includes('nao admitid')) return 'negativo';
    return 'neutro';
  }
  // Classifica um número de PER/DCOMP como 'credito' (constituiu o crédito, sem
  // referenciar outro PER/DCOMP) ou 'compensacao' (usa o saldo de um crédito já
  // constituído, referenciado em "Nº do PER/DCOMP Inicial"). Retorna null quando
  // não há PDF importado para esse número — não dá para saber sem o PDF.
  function classifyDocType(pdfRecord){
    if (!pdfRecord) return null;
    return pdfRecord.perdcompInicial ? 'compensacao' : 'credito';
  }

  // ---------- Armazenamento COMPARTILHADO: API REST do plugin WordPress ----------
  // Todo mundo que abre esta página vê e edita os MESMOS dados — um banco de documentos
  // guardado numa tabela própria do WordPress (ver perdcomp-panel.php), que sobrevive a
  // recarregar a página e trocar de sessão. Estrutura (idêntica à versão anterior, que
  // usava a capability "db" do Artifact — só o transporte mudou):
  //   clients/{slug}                          -> {name, cnpj, codMatrizFilial, count}
  //   clients/{slug}/documentos/{numeroPerdcomp} -> {record, pdf}  (1 doc por PER/DCOMP)
  //   clients/{slug}/config/lancamentos       -> {debito, credito, complemento} (overrides)
  //
  // O plugin injeta window.perdcompConfig = { root, nonce } via wp_localize_script antes
  // deste arquivo carregar (root = URL base da API REST, ex. .../wp-json/perdcomp/v1/;
  // nonce = nonce do WordPress pra autenticar como o usuário logado). Implementa a MESMA
  // interface doc()/collection() (get/set/delete/add) que o resto do código já usa — só
  // esta função muda; todo o resto do app é idêntico ao original.
  async function perdcompApiFetch(path, opts){
    const root = window.perdcompConfig && window.perdcompConfig.root;
    if (!root) throw new Error('perdcompConfig ausente — o plugin carregou certinho?');
    const res = await fetch(root.replace(/\/$/, '') + '/' + path, Object.assign({
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-WP-Nonce': (window.perdcompConfig && window.perdcompConfig.nonce) || '' }, (opts && opts.headers) || {})
    }, opts || {}));
    if (!res.ok){
      let msg = res.statusText;
      try{ const body = await res.json(); if (body && body.message) msg = body.message; }catch(e){}
      throw new Error('Erro na API (HTTP ' + res.status + '): ' + msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function makePerdcompRestDb(){
    function docRef(path){
      return {
        id: path.split('/').pop(),
        path,
        async get(){
          const body = await perdcompApiFetch('doc?path=' + encodeURIComponent(path));
          return { id: this.id, exists: !!(body && body.exists), data: () => (body && body.exists) ? body.data : undefined };
        },
        async set(data){ await perdcompApiFetch('doc', { method:'POST', body: JSON.stringify({ path, data }) }); },
        async update(data){ await perdcompApiFetch('doc', { method:'PATCH', body: JSON.stringify({ path, data }) }); },
        async delete(){ await perdcompApiFetch('doc?path=' + encodeURIComponent(path), { method:'DELETE' }); },
        collection(sub){ return collRef(path + '/' + sub); }
      };
    }
    function collRef(path){
      return {
        path,
        doc(id){ return docRef(path + '/' + id); },
        async add(data){
          const body = await perdcompApiFetch('collection', { method:'POST', body: JSON.stringify({ path, data }) });
          return docRef(path + '/' + body.id);
        },
        async get(){
          const body = await perdcompApiFetch('collection?path=' + encodeURIComponent(path));
          const docs = (body.docs || []).map(d => ({ id: d.id, exists:true, data: () => d.data }));
          return { docs, size: docs.length, empty: docs.length === 0 };
        },
        // Nenhum lugar do app usa query — sempre lista a "coleção" inteira e filtra em JS
        // (ver o resto do código) — mantidos só pra não quebrar se algo chamar por engano.
        where(){ return this; }, orderBy(){ return this; }, limit(){ return this; }
      };
    }
    return { doc: (p) => docRef(p), collection: (p) => collRef(p) };
  }
  let dbPromise = null;
  function getDb(){
    if (!dbPromise){
      dbPromise = (async () => {
        try{
          if (!(window.perdcompConfig && window.perdcompConfig.root)) return null;
          return makePerdcompRestDb();
        }catch(e){ console.error('db indisponível', e); return null; }
      })();
    }
    return dbPromise;
  }
  // ---------- Download: nada de backend aqui — é só o navegador salvando um arquivo ----------
  // A capability "downloads" do Artifact virava, por trás dos panos, exatamente isto: um
  // Blob + um <a download>. Não depende do WordPress nem de rede nenhuma.
  let downloadsPromise = null;
  function getDownloads(){
    if (!downloadsPromise){
      downloadsPromise = Promise.resolve({
        async save({ filename, data }){
          const blob = (data instanceof Blob) ? data : new Blob([data], { type:'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = filename; a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          return { status:'saved' };
        }
      });
    }
    return downloadsPromise;
  }
  function clientDocsPath(slug){ return 'clients/' + slug + '/documentos'; }
  function clientConfigPath(slug){ return 'clients/' + slug + '/config/lancamentos'; }
  function clientCreditosPath(slug){ return 'clients/' + slug + '/creditos'; }

  async function loadClients(){
    const database = await getDb();
    state.dbAvailable = !!database;
    if (!database){ state.clients = []; return; }
    try{
      const snap = await database.collection('clients').get();
      state.clients = snap.docs.map(d => {
        const b = d.data() || {};
        return { slug: d.id, name: b.name || '', cnpj: b.cnpj || '', codMatrizFilial: b.codMatrizFilial || '', count: b.count || 0 };
      }).sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));
    }catch(e){ console.error(e); state.clients = []; }
    if (state.clients.length && !state.selectedSlug){
      state.selectedSlug = state.clients[0].slug;
    }
  }
  // Grava só o cliente que mudou (nunca a lista inteira) — cada cadastro é seu próprio
  // documento, então editar um cliente nunca sobrescreve o que outra pessoa mudou em outro.
  async function saveClient(client){
    const database = await getDb();
    if (!database) return false;
    try{
      await database.collection('clients').doc(client.slug).set({
        name: client.name, cnpj: client.cnpj, codMatrizFilial: client.codMatrizFilial || '', count: client.count || 0
      });
      return true;
    }catch(e){ console.error(e); return false; }
  }
  async function deleteClientData(slug){
    const database = await getDb();
    if (!database) return;
    try{
      const docsSnap = await database.collection(clientDocsPath(slug)).get();
      await Promise.all(docsSnap.docs.map(d => database.collection(clientDocsPath(slug)).doc(d.id).delete()));
      await database.doc(clientConfigPath(slug)).delete().catch(()=>{});
      const creditosSnap = await database.collection(clientCreditosPath(slug)).get();
      await Promise.all(creditosSnap.docs.map(d => database.collection(clientCreditosPath(slug)).doc(d.id).delete()));
      await database.collection('clients').doc(slug).delete();
    }catch(e){ console.error(e); }
  }
  async function loadRecordsForSelected(){
    const empty = () => { state.records = []; state.pdfData = {}; state.lancOverrides = { debito:{}, credito:{}, debitoExtra:{}, creditoExtra:{}, complemento:{}, codHistorico:{}, iniciaLote:{}, matrizFilial:{}, centroCustoDebito:{}, centroCustoCredito:{} }; state.creditoEntries = []; };
    if (!state.selectedSlug){ empty(); return; }
    const database = await getDb();
    if (!database){ empty(); return; }
    try{
      const snap = await database.collection(clientDocsPath(state.selectedSlug)).get();
      const records = [], pdfData = {};
      snap.docs.forEach(d => {
        const b = d.data() || {};
        if (b.record) records.push(b.record);
        if (b.pdf) pdfData[b.pdf.numero || d.id] = b.pdf;
      });
      records.sort((a,b) => (b.dataTs||0) - (a.dataTs||0));
      state.records = records;
      state.pdfData = pdfData;
    }catch(e){ console.error(e); state.records = []; state.pdfData = {}; }
    try{
      const cfgSnap = await database.doc(clientConfigPath(state.selectedSlug)).get();
      // Documentos salvos antes destas colunas (Cód. Histórico, Inicia Lote, Matriz/Filial,
      // Centros de Custo) ou antes dos campos manuais do "lado vazio" (debitoExtra/
      // creditoExtra) existirem não têm esses baldes — mescla com o padrão pra nunca
      // quebrar um lookup em overrides.<campo>[groupKey] mais adiante.
      const baseOverrides = { debito:{}, credito:{}, debitoExtra:{}, creditoExtra:{}, complemento:{}, codHistorico:{}, iniciaLote:{}, matrizFilial:{}, centroCustoDebito:{}, centroCustoCredito:{} };
      state.lancOverrides = Object.assign(baseOverrides, (cfgSnap.exists && cfgSnap.data()) || {});
    }catch(e){ state.lancOverrides = { debito:{}, credito:{}, debitoExtra:{}, creditoExtra:{}, complemento:{}, codHistorico:{}, iniciaLote:{}, matrizFilial:{}, centroCustoDebito:{}, centroCustoCredito:{} }; }
    try{
      const creditosSnap = await database.collection(clientCreditosPath(state.selectedSlug)).get();
      state.creditoEntries = creditosSnap.docs.map(d => ({ id: d.id, ...(d.data()||{}) }))
        .sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
    }catch(e){ console.error(e); state.creditoEntries = []; }
  }
  async function saveLancOverrides(){
    if (!state.selectedSlug) return;
    const database = await getDb();
    if (!database) return;
    try{ await database.doc(clientConfigPath(state.selectedSlug)).set(state.lancOverrides); }catch(e){ console.error(e); }
  }
  // Um documento por PER/DCOMP — grava o resumo (record) e os campos extraídos do PDF
  // juntos, então importar um PDF nunca pisa nos dados de outro PER/DCOMP em paralelo.
  async function saveDocumento(slug, numero, record, pdf){
    const database = await getDb();
    if (!database) return false;
    try{
      await database.collection(clientDocsPath(slug)).doc(numero).set({ record, pdf });
      return true;
    }catch(e){ console.error(e); return false; }
  }
  // Lançamentos manuais de crédito (aba "Controle de crédito") — um documento por
  // lançamento, sob a subcoleção deste cliente, igual ao padrão de "documentos".
  async function saveCreditoEntry(slug, entry){
    const database = await getDb();
    if (!database) return false;
    try{
      const data = { tipoCredito: entry.tipoCredito, periodoCredito: entry.periodoCredito, valorOriginal: entry.valorOriginal, observacao: entry.observacao, createdAt: entry.createdAt || Date.now() };
      if (entry.id){
        await database.collection(clientCreditosPath(slug)).doc(entry.id).set(data);
        return entry.id;
      }
      const ref = await database.collection(clientCreditosPath(slug)).add(data);
      return ref.id;
    }catch(e){ console.error(e); return false; }
  }
  async function deleteCreditoEntry(slug, id){
    const database = await getDb();
    if (!database) return false;
    try{
      await database.collection(clientCreditosPath(slug)).doc(id).delete();
      return true;
    }catch(e){ console.error(e); return false; }
  }

  // ---------- PDF parsing ----------
  // Rótulos de todos os modelos de crédito conhecidos (COFINS/PIS Ressarc-Compensação,
  // Saldo Negativo de IRPJ/CSLL, Pagamento Indevido, etc.) — cada tipo de crédito usa
  // uma seção e uma nomenclatura ligeiramente diferente no PER/DCOMP da Receita.
  const PDF_LABELS = [
    'Nome Empresarial','Data de Criação','Data de Transmissão','Tipo de Documento','Tipo de Crédito',
    'PER/DCOMP Retificador','Crédito Oriundo de Ação Judicial','Qualificação do Contribuinte','Tipo da Conta',
    'Pessoa Jurídica Extinta por Liquidação Voluntária',
    'Informado em Processo Administrativo Anterior','Informado em Processo Administrativo anterior',
    'Informado em Outro PER/DCOMP','Nº do PER/DCOMP Inicial',
    'Crédito de Sucedida','Forma de Tributação no Período','Forma de Tributação do Lucro',
    'Tipo de Período do Crédito','Forma de Apuração','Período de Apuração','Trimestre do Crédito',
    'Saldo Credor RAIPI Ajustado', // rótulo seguinte a "Trimestre do Crédito" no ressarcimento de IPI, só pra delimitar
    'Data Inicial do Período','Data Final do Período','Ano',
    'Selic Acumulada','Imposto Devido',
    'Valor Original do Crédito Inicial','Valor do Saldo Negativo','Valor do Pedido de Restituição',
    'Total das Parcelas de Composição do Crédito',
    'Crédito Original na Data de Entrega','Crédito Original na Data da Entrega','Crédito Atualizado',
    'Total dos Débitos deste Documento','Total dos débitos desta DCOMP',
    'Total do Crédito Original Utilizado neste Documento','Total do Crédito Original Utilizado nesta DCOMP',
    'Saldo do Crédito Original'
  ];

  // Cada DCOMP de compensação lista um ou mais "débitos" compensados, cada um com seu
  // próprio bloco de campos (identificado por "CNPJ do Detentor do Débito", que se repete
  // uma vez por débito). Dentro de cada bloco, os rótulos abaixo aparecem uma única vez.
  const DEBITO_LABELS = [
    'Débito de Sucedida','Grupo de Tributo','Código da Receita/Denominação','Débito Controlado em Processo',
    'Período de Apuração','Periodicidade','Data de Vencimento do Tributo/Quota',
    'Número do Recibo de Transmissão DCTFWeb','Data de Transmissão DCTFWeb','Categoria DCTFWeb',
    'Indicativo de organismo estrangeiro DCTFWeb','Periodicidade DCTFWeb','Período Apuração DCTFWeb',
    'Principal','Multa','Juros','Total'
  ];

  function extractDebitos(flat){
    const marker = 'cnpj do detentor do débito';
    const lower = flat.toLowerCase();
    const starts = [];
    let idx = lower.indexOf(marker);
    while (idx !== -1){
      starts.push(idx);
      idx = lower.indexOf(marker, idx + marker.length);
    }
    return starts.map((s,i) => {
      const end = i+1 < starts.length ? starts[i+1] : flat.length;
      const block = flat.slice(s, end);
      const f = extractLabeledFields(block, DEBITO_LABELS);
      return {
        grupoTributo: f['Grupo de Tributo'] || '',
        descricao: f['Código da Receita/Denominação'] || '',
        periodoApuracao: f['Período de Apuração'] || '',
        vencimento: (f['Data de Vencimento do Tributo/Quota']||'').match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || '',
        principal: parseBRL(f['Principal']),
        multa: parseBRL(f['Multa']),
        juros: parseBRL(f['Juros']),
        total: parseBRL(f['Total'])
      };
    });
  }

  function extractLabeledFields(flat, labels){
    const lower = flat.toLowerCase();
    const found = [];
    labels.forEach(label => {
      const idx = lower.indexOf(label.toLowerCase());
      if (idx !== -1) found.push({ label, idx, end: idx + label.length });
    });
    found.sort((a,b) => a.idx - b.idx);
    const result = {};
    found.forEach((f,i) => {
      const nextIdx = i+1 < found.length ? found[i+1].idx : flat.length;
      result[f.label] = flat.slice(f.end, nextIdx).trim();
    });
    return result;
  }

  function parseBRL(str){
    if (!str) return null;
    const m = String(str).match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/);
    if (!m) return null;
    return parseFloat(m[0].replace(/\./g,'').replace(',','.'));
  }

  function fmtBRL(n){
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  }

  // Pega o primeiro campo (na ordem dada) que existir no documento — cobre as
  // variações de nomenclatura entre tipos de crédito/documento.
  function firstField(f, keys){
    for (const k of keys){ if (f[k]) return f[k]; }
    return '';
  }

  // Confere se o PDF realmente é um PER/DCOMP da Receita Federal antes de tentar
  // importar — evita que qualquer PDF (outro formulário, um contrato, um PDF em
  // branco/escaneado sem texto) seja aceito só porque tem números parecidos.
  // Checa os elementos fixos do cabeçalho do formulário: "Receita Federal", o título
  // "Pedido de Restituição... e Declaração de Compensação", o rótulo "PERDCOMP",
  // o rótulo "CNPJ" e a seção "Dados Iniciais".
  function isPerdcompStructure(flat){
    const n = normalize(flat);
    return n.includes('receita federal')
      && n.includes('pedido de restituicao')
      && n.includes('declaracao de compensacao')
      && n.includes('perdcomp')
      && n.includes('cnpj')
      && n.includes('dados iniciais');
  }

  function parsePerdcompPdfText(text){
    const flat = text.replace(/\s+/g,' ').trim();
    const codeRegex = /\d{5}\.\d{5}\.\d{6}\.\d\.\d\.\d{2}-\d{4}/g;
    const allCodes = flat.match(codeRegex) || [];
    const freq = {};
    allCodes.forEach(c => freq[c] = (freq[c]||0)+1);
    let numero = null, max = 0;
    Object.entries(freq).forEach(([c,n]) => { if (n > max){ max = n; numero = c; } });

    const f = extractLabeledFields(flat, PDF_LABELS);
    const cnpjMatch = flat.match(/CNPJ\s+(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);

    let perdcompInicial = firstField(f, ['Nº do PER/DCOMP Inicial']);
    const inicialMatch = perdcompInicial.match(codeRegex);
    perdcompInicial = inicialMatch ? inicialMatch[0] : '';

    const dataTransmissao = (f['Data de Transmissão'] || '').match(/\d{2}\/\d{2}\/\d{4}/) ? (f['Data de Transmissão'].match(/\d{2}\/\d{2}\/\d{4}/)[0]) : '';
    const dtm = dataTransmissao.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const dataTsRaw = dtm ? new Date(Number(dtm[3]), Number(dtm[2])-1, Number(dtm[1])).getTime() : 0;

    // Data de Criação — separada da Data de Transmissão, usada como filtro de período
    // na aba de Lançamentos contábeis.
    const dataCriacao = (f['Data de Criação'] || '').match(/\d{2}\/\d{2}\/\d{4}/) ? (f['Data de Criação'].match(/\d{2}\/\d{2}\/\d{4}/)[0]) : '';
    const dcm = dataCriacao.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const dataCriacaoTsRaw = dcm ? new Date(Number(dcm[3]), Number(dcm[2])-1, Number(dcm[1])).getTime() : 0;

    const debitos = extractDebitos(flat);
    // O campo-resumo "Total dos Débitos..." muda de redação entre modelos de PER/DCOMP
    // (e em alguns nem aparece do jeito esperado) — quando os débitos individuais foram
    // extraídos, a soma deles é mais confiável que esse campo isolado.
    const totalDebitosCampo = parseBRL(firstField(f, [
      'Total dos Débitos deste Documento', 'Total dos débitos desta DCOMP'
    ]));
    const totalDebitos = debitos.length ? debitos.reduce((s,d) => s + (d.total || 0), 0) : totalDebitosCampo;

    return {
      numero,
      cnpj: cnpjMatch ? cnpjMatch[1] : '',
      nomeEmpresarial: f['Nome Empresarial'] || '',
      tipoDocumento: f['Tipo de Documento'] || '',
      tipoCredito: f['Tipo de Crédito'] || '',
      dataTransmissao,
      dataTsRaw,
      dataCriacao,
      dataCriacaoTsRaw,
      perdcompInicial,
      valorCreditoInicial: parseBRL(firstField(f, [
        'Valor Original do Crédito Inicial', 'Valor do Saldo Negativo', 'Valor do Pedido de Restituição'
      ])),
      creditoEntrega: parseBRL(firstField(f, [
        'Crédito Original na Data de Entrega', 'Crédito Original na Data da Entrega'
      ])),
      creditoAtualizado: parseBRL(f['Crédito Atualizado']),
      totalDebitos,
      totalCreditoUtilizado: parseBRL(firstField(f, [
        'Total do Crédito Original Utilizado neste Documento', 'Total do Crédito Original Utilizado nesta DCOMP'
      ])),
      saldoCreditoOriginal: parseBRL(f['Saldo do Crédito Original']),
      // Período de origem do crédito: aparece como "Período de Apuração" (ex.: Saldo
      // Negativo de IRPJ/CSLL) ou "Trimestre do Crédito" (ex.: ressarcimento de IPI),
      // dependendo do tipo de crédito.
      periodoCredito: firstField(f, ['Período de Apuração', 'Trimestre do Crédito']),
      debitos
    };
  }

  async function extractPdfText(file){
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n';
    }
    return text;
  }

  function parseBrDate(str){
    const m = (str||'').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return { display:'—', iso:'', ts:0 };
    const d = new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
    return { display: str, iso: m[3]+'-'+m[2]+'-'+m[1], ts: d.getTime() };
  }

  async function handlePdfFiles(fileList){
    if (!state.selectedSlug || !fileList.length) return;
    state.uploadMsg = { text:'Lendo PDF(s)…', kind:'' };
    render();

    const client = state.clients.find(c => c.slug === state.selectedSlug);
    let ok = 0, fail = 0, novosRegistros = 0;
    const rejected = []; // { label, reason: 'estrutura'|'cnpj', cnpj? }
    const toSave = []; // { numero, record, pdf } — gravados no banco compartilhado depois do loop
    for (const file of fileList){
      try{
        const text = await extractPdfText(file);
        const flat = text.replace(/\s+/g,' ').trim();
        // Antes de tentar extrair qualquer campo, confere se o PDF realmente tem a
        // estrutura de um PER/DCOMP da Receita Federal — evita importar qualquer
        // outro tipo de PDF só porque algum número no texto parece um código de PER/DCOMP.
        if (!isPerdcompStructure(flat)){
          rejected.push({ label: file.name, reason: 'estrutura' });
          continue;
        }
        const parsed = parsePerdcompPdfText(text);
        if (!parsed.numero){
          rejected.push({ label: file.name, reason: 'estrutura' });
          continue;
        }
        // Se o cliente tem CNPJ cadastrado, todo PDF importado precisa bater com ele —
        // documento de outra empresa não é aceito neste cliente.
        const parsedCnpjDigits = onlyDigits(parsed.cnpj);
        if (client && client.cnpj && parsedCnpjDigits && parsedCnpjDigits !== client.cnpj){
          rejected.push({ label: file.name, reason: 'cnpj', cnpj: parsedCnpjDigits });
          continue;
        }
        state.pdfData[parsed.numero] = parsed;
        ok++;
        let record = state.records.find(r => r.numero === parsed.numero);
        if (!record){
          const dt = parseBrDate(parsed.dataTransmissao);
          record = {
            numero: parsed.numero,
            dataDisplay: dt.display,
            dataIso: dt.iso,
            dataTs: dt.ts,
            tipoCredito: parsed.tipoCredito || '—',
            tipoDocumento: parsed.tipoDocumento || '—',
            situacao: 'Sem dado da planilha'
          };
          state.records.push(record);
          novosRegistros++;
        }
        toSave.push({ numero: parsed.numero, record, pdf: parsed });
      }catch(e){ console.error(e); fail++; }
    }

    state.records.sort((a,b) => b.dataTs - a.dataTs);
    // Um documento por PER/DCOMP — importar em paralelo em outra aba/computador nunca
    // sobrescreve o lote inteiro, só o(s) número(s) realmente lido(s) agora.
    await Promise.all(toSave.map(item => saveDocumento(state.selectedSlug, item.numero, item.record, item.pdf)));
    if (client && toSave.length){ client.count = state.records.length; await saveClient(client); }

    const estruturaFail = rejected.filter(r => r.reason === 'estrutura').length;
    const cnpjFail = rejected.filter(r => r.reason === 'cnpj').length;
    let msg = ok + ' PDF(s) lido(s)';
    if (novosRegistros) msg += ', ' + novosRegistros + ' registro(s) novo(s)';
    if (estruturaFail) msg += ', ' + estruturaFail + ' não importado(s) por não ser PER/DCOMP';
    if (cnpjFail) msg += ', ' + cnpjFail + ' não importado(s) por CNPJ divergente';
    if (fail) msg += ', ' + fail + ' com falha na leitura';
    state.uploadMsg = { text: msg + '.', kind: (ok ? 'ok' : 'err') };
    render();
    if (rejected.length) openImportFailModal(rejected, client && client.cnpj, 'pdf');
  }

  function openClientModal(slug, opts){
    state.modalNumero = null; state.modalRoot = null; state.modalImportFails = null; state.modalCredito = null; state.modalConfirm = null;
    state.modalClient = { slug: slug || null, notice: (opts && opts.notice) || null, focus: (opts && opts.focus) || null };
    renderModal();
  }
  function closeClientModal(){
    state.modalClient = null;
    renderModal();
  }

  function openImportFailModal(items, expectedCnpjDigits, contextLabel){
    state.modalNumero = null; state.modalRoot = null; state.modalClient = null; state.modalCredito = null; state.modalConfirm = null;
    state.modalImportFails = { items, expected: expectedCnpjDigits, contextLabel };
    renderModal();
  }
  function closeImportFailModal(){
    state.modalImportFails = null;
    renderModal();
  }

  function openCreditoModal(id, opts){
    state.modalNumero = null; state.modalRoot = null; state.modalClient = null; state.modalImportFails = null; state.modalConfirm = null;
    state.modalCredito = { id: id || null, notice: (opts && opts.notice) || null };
    renderModal();
  }
  function closeCreditoModal(){
    state.modalCredito = null;
    renderModal();
  }

  // Modal de confirmação genérico, pra qualquer ação destrutiva (remover cliente, remover
  // lançamento de crédito, etc.) — substitui window.confirm(), que não funciona dentro do
  // iframe em sandbox deste Artifact: clicar em "Remover" com confirm() nativo não abria
  // nenhum diálogo e simplesmente não fazia nada, sem erro nenhum no console.
  function openConfirmModal(message, onConfirm, opts){
    state.modalNumero = null; state.modalRoot = null; state.modalClient = null; state.modalImportFails = null; state.modalCredito = null;
    state.modalConfirm = { title: (opts && opts.title) || 'Confirmar', message, confirmLabel: (opts && opts.confirmLabel) || 'Remover', onConfirm };
    renderModal();
  }
  function closeConfirmModal(){
    state.modalConfirm = null;
    renderModal();
  }
  async function submitCreditoForm(){
    const tipoInput = document.getElementById('creditoTipoInput');
    const periodoInput = document.getElementById('creditoPeriodoInput');
    const valorInput = document.getElementById('creditoValorInput');
    const obsInput = document.getElementById('creditoObsInput');
    const errBox = document.getElementById('creditoFormError');
    const tipoCredito = tipoInput.value.trim();
    const periodoCredito = periodoInput.value.trim();
    const valorOriginal = currencyInputToNumber(valorInput.value);
    const observacao = obsInput.value.trim();
    if (!tipoCredito){ errBox.textContent = 'Informe o tipo de crédito.'; return; }
    if (!periodoCredito){ errBox.textContent = 'Informe o período do crédito.'; return; }

    const editingId = state.modalCredito.id;
    const entry = { id: editingId, tipoCredito, periodoCredito, valorOriginal, observacao };
    if (editingId){
      const existing = state.creditoEntries.find(c => c.id === editingId);
      entry.createdAt = existing ? existing.createdAt : Date.now();
    } else {
      entry.createdAt = Date.now();
    }
    const savedId = await saveCreditoEntry(state.selectedSlug, entry);
    if (!savedId){ errBox.textContent = 'Não consegui salvar agora. Tente de novo.'; return; }
    if (editingId){
      const idx = state.creditoEntries.findIndex(c => c.id === editingId);
      if (idx !== -1) state.creditoEntries[idx] = { ...entry, id: editingId };
    } else {
      state.creditoEntries.unshift({ ...entry, id: savedId });
    }
    state.modalCredito = null;
    render();
    renderModal();
  }
  function deleteCreditoEntryConfirm(id){
    const entry = state.creditoEntries.find(c => c.id === id);
    if (!entry) return;
    const slug = state.selectedSlug;
    openConfirmModal(
      'Remover o lançamento "' + (entry.tipoCredito||'—') + ' — ' + (entry.periodoCredito||'—') + '"? Essa ação não pode ser desfeita.',
      async () => {
        state.creditoEntries = state.creditoEntries.filter(c => c.id !== id);
        render();
        await deleteCreditoEntry(slug, id);
      },
      { title: 'Remover lançamento de crédito' }
    );
  }
  async function submitClientForm(){
    const nameInput = document.getElementById('clientNameInput');
    const cnpjInput = document.getElementById('clientCnpjInput');
    const errBox = document.getElementById('clientFormError');
    const matrizInput = document.getElementById('clientMatrizInput');
    const name = nameInput.value.trim();
    const cnpjDigits = onlyDigits(cnpjInput.value);
    const codMatrizFilial = onlyDigits(matrizInput ? matrizInput.value : '');
    if (!name){ errBox.textContent = 'Informe o nome da empresa.'; return; }
    if (cnpjDigits.length !== 14){ errBox.textContent = 'CNPJ incompleto — informe os 14 números.'; return; }
    if (!isValidCnpj(cnpjDigits)){ errBox.textContent = 'Esse CNPJ não parece válido. Confira os números digitados.'; return; }
    const editingSlug = state.modalClient.slug;
    const dup = state.clients.find(c => c.cnpj === cnpjDigits && c.slug !== editingSlug);
    if (dup){ errBox.textContent = 'Esse CNPJ já está cadastrado para "' + dup.name + '".'; return; }

    let targetClient;
    if (editingSlug){
      targetClient = state.clients.find(c => c.slug === editingSlug);
      if (targetClient){ targetClient.name = name; targetClient.cnpj = cnpjDigits; targetClient.codMatrizFilial = codMatrizFilial; }
    } else {
      let slug = slugify(name);
      let base = slug, i = 2;
      while (state.clients.some(c => c.slug === slug)){ slug = base + '-' + i; i++; }
      targetClient = { slug, name, cnpj: cnpjDigits, codMatrizFilial, count: 0 };
      state.clients.push(targetClient);
      state.selectedSlug = slug;
      state.filters = { q:'', credito:'', documento:'', situacao:'', natureza:'', from:'', to:'' }; state.compFilters = { busca:'', from:'', to:'' }; state.lancFilters = { from:'', to:'', busca:'' }; state.activeTab = 'registros';
      await loadRecordsForSelected();
    }
    await saveClient(targetClient);
    state.modalClient = null;
    render();
    renderModal();
  }

  function deleteClient(slug, ev){
    ev.stopPropagation();
    const c = state.clients.find(c => c.slug === slug);
    if (!c) return;
    openConfirmModal(
      'Remover "' + c.name + '" e todos os registros importados dele? Essa ação não pode ser desfeita.',
      async () => {
        state.clients = state.clients.filter(c => c.slug !== slug);
        await deleteClientData(slug);
        if (state.selectedSlug === slug){
          state.selectedSlug = state.clients.length ? state.clients[0].slug : null;
          state.filters = { q:'', credito:'', documento:'', situacao:'', natureza:'', from:'', to:'' }; state.compFilters = { busca:'', from:'', to:'' }; state.lancFilters = { from:'', to:'', busca:'' }; state.activeTab = 'registros';
          await loadRecordsForSelected();
        }
        render();
      },
      { title: 'Remover cliente' }
    );
  }

  async function selectClient(slug){
    if (state.selectedSlug === slug) return;
    state.selectedSlug = slug;
    state.filters = { q:'', credito:'', documento:'', situacao:'', natureza:'', from:'', to:'' }; state.compFilters = { busca:'', from:'', to:'' }; state.lancFilters = { from:'', to:'', busca:'' }; state.activeTab = 'registros';
    state.uploadMsg = null;
    render();
    await loadRecordsForSelected();
    render();
  }

  function applyFilters(records){
    const f = state.filters;
    const fromIso = dateBrToIso(f.from);
    const toIso = dateBrToIso(f.to);
    return records.filter(r => {
      if (f.q && !normalize(r.numero).includes(normalize(f.q))) return false;
      if (f.credito && r.tipoCredito !== f.credito) return false;
      if (f.documento && r.tipoDocumento !== f.documento) return false;
      if (f.situacao && r.situacao !== f.situacao) return false;
      if (f.natureza && classifyDocType(state.pdfData[r.numero]) !== f.natureza) return false;
      if (fromIso && r.dataIso && r.dataIso < fromIso) return false;
      if (toIso && r.dataIso && r.dataIso > toIso) return false;
      return true;
    });
  }

  function distinctSorted(records, field){
    return [...new Set(records.map(r => r[field]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  }

  // ---------- Créditos por origem (raiz = Pedido de Ressarcimento, ou o próprio
  // PER/DCOMP quando o tipo de crédito dispensa ressarcimento prévio — ex.:
  // Pagamento Indevido/a Maior, Base Negativa) ----------
  // REGRA: nunca soma/vincula saldo entre CNPJs diferentes, mesmo que um PER/DCOMP
  // aponte para outro como "inicial" (ex.: sucessão empresarial) — documentos de
  // CNPJ divergente do CNPJ predominante da origem ficam de fora do cálculo e
  // aparecem separados, sinalizados.
  function computeCreditRoots(pdfData){
    const groups = {};
    Object.values(pdfData).forEach(p => {
      const root = p.perdcompInicial || p.numero;
      (groups[root] = groups[root] || []).push(p);
    });
    return Object.entries(groups).map(([root, allMembers]) => {
      allMembers.sort((a,b) => (a.dataTsRaw||0) - (b.dataTsRaw||0));

      const cnpjFreq = {};
      allMembers.forEach(m => { if (m.cnpj) cnpjFreq[m.cnpj] = (cnpjFreq[m.cnpj]||0) + 1; });
      let refCnpj = null, maxN = 0;
      Object.entries(cnpjFreq).forEach(([c,n]) => { if (n > maxN){ maxN = n; refCnpj = c; } });

      const members = allMembers.filter(m => !refCnpj || !m.cnpj || m.cnpj === refCnpj);
      const outrasEmpresas = allMembers.filter(m => refCnpj && m.cnpj && m.cnpj !== refCnpj);

      // O PER/DCOMP que CONSTITUIU o crédito (não referencia outro) define o valor
      // original. Os PER/DCOMP de COMPENSAÇÃO (referenciam esse número como "PER/DCOMP
      // Inicial") são os que efetivamente abatem o saldo, um após o outro.
      const creditoMembers = members.filter(m => classifyDocType(m) === 'credito');
      const compensacaoMembers = members.filter(m => classifyDocType(m) === 'compensacao');
      const origemImportada = creditoMembers.length > 0;

      let valorOriginal = null;
      (origemImportada ? creditoMembers : members).forEach(m => {
        if (valorOriginal == null && m.valorCreditoInicial != null) valorOriginal = m.valorCreditoInicial;
      });

      let periodoCredito = '';
      (origemImportada ? creditoMembers : members).forEach(m => {
        if (!periodoCredito && m.periodoCredito) periodoCredito = m.periodoCredito;
      });

      // Saldo atual = valor original do crédito − total do crédito já utilizado em TODOS
      // os documentos importados desta origem (soma do "Total do Crédito Original
      // Utilizado" de cada um, incluindo o próprio documento de crédito quando ele já
      // usa parte do saldo na mesma declaração). Não usamos o "Saldo do Crédito Original"
      // relatado em um documento isolado como referência: quando várias compensações têm
      // a mesma data de transmissão, a ordem entre elas é ambígua e esse campo pode não
      // refletir o saldo mais atual — a conta abaixo é sempre confiável.
      let saldoAtual = null, saldoEstimado = false;
      if (valorOriginal != null){
        const usados = members.reduce((s,m) => s + (m.totalCreditoUtilizado || 0), 0);
        saldoAtual = Math.max(valorOriginal - usados, 0);
      } else {
        // Sem o documento de origem (valor original desconhecido): não dá pra fazer a
        // conta — cai para o saldo mais recente relatado entre os documentos importados,
        // por segurança, e sinaliza que é aproximado.
        for (let i = members.length - 1; i >= 0; i--){
          if (members[i].saldoCreditoOriginal != null){ saldoAtual = members[i].saldoCreditoOriginal; break; }
        }
        if (saldoAtual == null){
          const saldos = members.map(m => m.saldoCreditoOriginal).filter(v => v != null);
          saldoAtual = saldos.length ? Math.min(...saldos) : null;
        }
        saldoEstimado = saldoAtual != null;
      }

      return {
        root,
        cnpj: refCnpj,
        valorOriginal,
        saldoAtual,
        saldoEstimado,
        tipoCredito: members[0].tipoCredito,
        periodoCredito,
        origemImportada,
        qtdCompensacoes: compensacaoMembers.length,
        members,
        outrasEmpresas
      };
    }).sort((a,b) => (b.saldoAtual||0) - (a.saldoAtual||0));
  }

  // Situação de um lançamento manual da aba "Controle de crédito": compara Tipo de
  // crédito + Período do crédito (digitados à mão) com as origens de crédito já
  // identificadas nos PER/DCOMP importados (computeCreditRoots) — comparação insensível
  // a acento/maiúsculas (normalize), já que são duas fontes digitadas independentemente.
  // Achou uma origem com o mesmo tipo+período: esse crédito já está registrado ali, então
  // "CREDITO INDISPONIVEL"; não achou: ainda não apareceu em nenhum PER/DCOMP importado,
  // "CREDITO DISPONIVEL".
  // Forma "canônica" de um texto pra comparar tipo/período: além de tirar acento e caixa
  // (normalize), remove TODO caractere que não seja letra/número — espaços, barras, º/°,
  // pontuação. Isso resolve dois problemas reais de digitação/extração independentes:
  // (1) "3º Trimestre/2023" digitado à mão pode usar um símbolo de ordinal (º, U+00BA)
  // diferente do que veio de um PDF (°, U+00B0, ou nenhum) — visualmente idênticos, mas
  // caracteres diferentes, então normalize() sozinho não resolve (não é acento); (2) o
  // texto extraído de um PDF real às vezes carrega espaçamento/quebras de linha diferentes
  // do que a pessoa digitaria. Reduzindo os dois lados a só letras/números, "3º Trimestre/2023"
  // e "3o trimestre 2023" (ou variações de espaçamento) comparam iguais.
  function canonForMatch(str){
    return normalize(str||'').replace(/[^a-z0-9]+/g, '');
  }
  function creditoSituacao(entry, creditRoots){
    const tipo = canonForMatch(entry.tipoCredito);
    const periodo = canonForMatch(entry.periodoCredito);
    if (!tipo || !periodo) return 'disponivel';
    const match = (creditRoots||[]).some(r => {
      const rTipo = canonForMatch(r.tipoCredito);
      const rPeriodo = canonForMatch(r.periodoCredito);
      if (!rTipo || !rPeriodo || rTipo !== tipo) return false;
      // Igualdade exata é o caso normal; "contém" cobre quando o campo extraído do PDF
      // carrega texto extra além do período em si (um rótulo seguinte não reconhecido,
      // por exemplo) — desde que um dos dois textos comece pelo outro por inteiro.
      return rPeriodo === periodo || rPeriodo.includes(periodo) || periodo.includes(rPeriodo);
    });
    return match ? 'indisponivel' : 'disponivel';
  }

  // Periodicidade sugerida (calculada, nunca digitada) a partir do Tipo de crédito, pra
  // ajudar a preencher o Período do crédito certo (trimestre x ano, por exemplo) e evitar
  // erro de digitação. Comparação por palavra-chave (normalize já tira acento/caixa), na
  // ordem certa pra não confundir "Pagamento Indevido ou a Maior – PIS" com os créditos de
  // PIS/COFINS propriamente ditos.
  function creditoPeriodicidade(tipoCredito){
    const t = normalize(tipoCredito||'');
    if (!t) return '';
    if (t.includes('saldo negativo')) return 'Trimestral/Anual';
    if (t.includes('pagamento indevido') || t.includes('a maior')) return 'Conforme DARF';
    if (t.includes('retencao')) return 'Conforme retenção';
    if (t.includes('prejuizo fiscal')) return 'Anual';
    if (t.includes('base negativa')) return 'Anual';
    if (t.includes('judicial')) return 'Conforme processo';
    if (t.includes('ipi')) return 'Trimestral';
    if (t.includes('pis') && t.includes('cofins')) return 'Trimestral';
    return '—';
  }

  // Formato de digitação do Período do crédito, a partir da Periodicidade calculada acima.
  // Só forçamos uma máscara rígida quando o formato é único e sem ambiguidade (Trimestral,
  // Anual, Conforme DARF, e Conforme retenção — que na prática é sempre por competência
  // mensal). Quando a periodicidade admite mais de um formato válido ("Trimestral/Anual",
  // que pode ser por estimativa trimestral ou por ajuste anual) ou não tem um padrão de
  // dígitos fixo ("Conforme processo", texto livre), deixamos o campo livre pra digitação —
  // forçar uma única máscara aí erraria pra quem precisa do outro formato válido.
  function creditoPeriodoMascara(tipoCredito){
    const p = creditoPeriodicidade(tipoCredito);
    if (p === 'Trimestral') return 'trimestral';
    if (p === 'Anual') return 'anual';
    if (p === 'Conforme DARF') return 'darf';
    if (p === 'Conforme retenção') return 'mensal';
    return 'livre';
  }
  function creditoPeriodoPlaceholder(tipoCredito){
    const mascara = creditoPeriodoMascara(tipoCredito);
    if (mascara === 'trimestral') return 'Ex.: 1º Trimestre/2026';
    if (mascara === 'anual') return 'Ex.: 2026';