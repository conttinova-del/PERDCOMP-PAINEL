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
    if (mascara === 'darf') return 'Ex.: 25/08/2026';
    if (mascara === 'mensal') return 'Ex.: 08/2026';
    if (creditoPeriodicidade(tipoCredito) === 'Trimestral/Anual') return 'Ex.: 1º Trimestre/2026 ou 2026';
    if (creditoPeriodicidade(tipoCredito) === 'Conforme processo') return 'Ex.: nº do processo, ex. 10880.123456/2026-11';
    return 'Ex.: 4º Trimestre/2023';
  }
  function aplicaCreditoPeriodoMascara(mascara, v){
    if (mascara === 'trimestral') return formatQuarterYear(v);
    if (mascara === 'anual') return formatYearOnly(v);
    if (mascara === 'darf') return formatDateBr(v);
    if (mascara === 'mensal') return formatMonthYear(v);
    return v;
  }
  // Campo "Período do crédito": pra cada Periodicidade com um formato fixo (Mensal,
  // Trimestral, Conforme DARF, e o caso ambíguo Trimestral/Anual), a parte de TEXTO do
  // formato ("/", "º Trimestre/") não é mais digitável — só as posições numéricas (os "x"
  // do formato, ex. "xx/xxxx") são campos de verdade, cada um só aceita dígito e trava no
  // tamanho certo. Isso elimina de vez erro de digitação na parte fixa (barra faltando,
  // "Trimestre" mal escrito, etc.). Só ficam como texto livre de verdade os dois formatos
  // sem posições fixas: Anual (só dígitos, nada pra travar) e Conforme processo/tipo sem
  // periodicidade reconhecida (é texto livre por natureza — número de processo etc.).
  // Em todo modo existe um #creditoPeriodoInput (visível, texto livre; ou oculto, montado
  // a partir dos campos numéricos) com o valor final pronto pro resto do código
  // (submitCreditoForm etc.) usar sem precisar saber qual modo está ativo.
  function creditoPeriodoHibrido(tipoCredito){
    return creditoPeriodicidade(tipoCredito) === 'Trimestral/Anual';
  }
  // Chave do "modo" de campo que deve estar renderizado pra este Tipo de crédito — usada
  // pra saber quando reconstruir o campo (só quando o modo muda, nunca a cada tecla).
  function creditoPeriodoModo(tipoCredito){
    const mascara = creditoPeriodoMascara(tipoCredito);
    if (mascara === 'trimestral') return 'trimestral';
    if (mascara === 'mensal') return 'mensal';
    if (mascara === 'darf') return 'darf';
    if (creditoPeriodoHibrido(tipoCredito)) return 'hibrido';
    return 'livre'; // Anual (só dígitos) ou Conforme processo/desconhecido (texto livre)
  }
  // Lê um período já salvo ("3º Trimestre/2026") de volta pros campos trimestre+ano.
  function parseTrimestreAno(periodoVal){
    const m = String(periodoVal || '').match(/^([1-4])º\s*Trimestre\s*\/\s*(\d{0,4})$/i);
    return m ? { quarter: m[1], ano: m[2] } : { quarter: '1', ano: '' };
  }
  // Lê um período já salvo ("08/2026") de volta pros campos mês+ano.
  function parseMesAno(periodoVal){
    const m = String(periodoVal || '').match(/^(\d{0,2})\/(\d{0,4})$/);
    return m ? { mes: m[1], ano: m[2] } : { mes: '', ano: '' };
  }
  // Lê um período já salvo ("25/08/2026") de volta pros campos dia+mês+ano.
  function parseDiaMesAno(periodoVal){
    const m = String(periodoVal || '').match(/^(\d{0,2})\/(\d{0,2})\/(\d{0,4})$/);
    return m ? { dia: m[1], mes: m[2], ano: m[3] } : { dia: '', mes: '', ano: '' };
  }
  // Lê um período já salvo ("3º Trimestre/2026" ou "2026") de volta pro seletor Trimestre/Ano.
  function parseCreditoPeriodoHibrido(periodoVal){
    const mTri = String(periodoVal || '').match(/^([1-4])º\s*Trimestre\s*\/\s*(\d{4})$/i);
    if (mTri) return { subTipo: 'trimestre', quarter: mTri[1], ano: mTri[2] };
    const mAno = String(periodoVal || '').match(/^(\d{4})$/);
    if (mAno) return { subTipo: 'ano', quarter: '1', ano: mAno[1] };
    return { subTipo: 'trimestre', quarter: '1', ano: '' };
  }
  // <select> "1º"–"4º" + o texto fixo "Trimestre /" — pedaço reaproveitado tanto no modo
  // Trimestral puro quanto dentro do seletor Trimestre/Ano do modo híbrido.
  function trimestreQuarterFieldHtml(quarter){
    return `<select id="creditoPeriodoQuarterSel" class="form-input" style="width:auto;max-width:62px;flex:0 0 auto;">`
      + [1,2,3,4].map(q => `<option value="${q}" ${String(q) === quarter ? 'selected' : ''}>${q}º</option>`).join('')
      + `</select><span style="color:var(--paper-dim);font-size:13px;white-space:nowrap;">Trimestre /</span>`;
  }
  function periodoNumInputHtml(id, value, maxlen, placeholder, widthPx){
    return `<input type="text" id="${id}" class="form-input" inputmode="numeric" maxlength="${maxlen}" style="width:auto;max-width:${widthPx}px;flex:0 0 auto;text-align:center;" placeholder="${placeholder}" value="${esc(value)}" />`;
  }
  function creditoPeriodoBodyHtml(tipoCredito, periodoVal){
    const modo = creditoPeriodoModo(tipoCredito);
    if (modo === 'trimestral'){
      const { quarter, ano } = parseTrimestreAno(periodoVal);
      return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">`
        + trimestreQuarterFieldHtml(quarter)
        + periodoNumInputHtml('creditoPeriodoAnoInput', ano, 4, 'AAAA', 90)
        + `</div><input type="hidden" id="creditoPeriodoInput" value="${esc(periodoVal)}" />`;
    }
    if (modo === 'mensal'){
      const { mes, ano } = parseMesAno(periodoVal);
      return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">`
        + periodoNumInputHtml('creditoPeriodoMesInput', mes, 2, 'MM', 52)
        + `<span style="color:var(--paper-dim);font-size:13px;">/</span>`
        + periodoNumInputHtml('creditoPeriodoAnoInput', ano, 4, 'AAAA', 90)
        + `</div><input type="hidden" id="creditoPeriodoInput" value="${esc(periodoVal)}" />`;
    }
    if (modo === 'darf'){
      const { dia, mes, ano } = parseDiaMesAno(periodoVal);
      return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">`
        + periodoNumInputHtml('creditoPeriodoDiaInput', dia, 2, 'DD', 52)
        + `<span style="color:var(--paper-dim);font-size:13px;">/</span>`
        + periodoNumInputHtml('creditoPeriodoMesInput', mes, 2, 'MM', 52)
        + `<span style="color:var(--paper-dim);font-size:13px;">/</span>`
        + periodoNumInputHtml('creditoPeriodoAnoInput', ano, 4, 'AAAA', 90)
        + `</div><input type="hidden" id="creditoPeriodoInput" value="${esc(periodoVal)}" />`;
    }
    if (modo === 'hibrido'){
      const { subTipo, quarter, ano } = parseCreditoPeriodoHibrido(periodoVal);
      return `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="creditoPeriodoTipoSel" class="form-input" style="width:auto;max-width:120px;flex:0 0 auto;">
            <option value="trimestre" ${subTipo === 'trimestre' ? 'selected' : ''}>Trimestre</option>
            <option value="ano" ${subTipo === 'ano' ? 'selected' : ''}>Ano</option>
          </select>
          <span id="creditoPeriodoTrimestreGroup" style="display:${subTipo === 'trimestre' ? 'inline-flex' : 'none'};align-items:center;gap:6px;">
            ${trimestreQuarterFieldHtml(quarter)}
          </span>
          ${periodoNumInputHtml('creditoPeriodoAnoInput', ano, 4, 'AAAA', 90)}
        </div>
        <input type="hidden" id="creditoPeriodoInput" value="${esc(periodoVal)}" />`;
    }
    // 'livre': Anual (só dígitos, sem parte fixa pra travar) ou Conforme processo/tipo sem
    // periodicidade reconhecida (texto livre de verdade, por natureza).
    return `<input type="text" id="creditoPeriodoInput" class="form-input" maxlength="300" value="${esc(periodoVal)}" placeholder="${esc(creditoPeriodoPlaceholder(tipoCredito))}" />`;
  }
  // Liga os eventos do corpo do campo "Período do crédito" — chamar de novo sempre que o
  // HTML acima for reconstruído (ao abrir o modal e sempre que o Tipo de crédito digitado
  // trocar de modo). Cada campo numérico só aceita dígito (onlyDigits) e trava no tamanho
  // do formato; o valor final só é montado (e a validação de "período obrigatório" só
  // passa) quando TODAS as posições numéricas daquele formato estiverem completas.
  function wireCreditoPeriodoBody(tipoInputEl){
    const hidden = document.getElementById('creditoPeriodoInput');
    const tipoSel = document.getElementById('creditoPeriodoTipoSel');
    const quarterSel = document.getElementById('creditoPeriodoQuarterSel');
    const diaInput = document.getElementById('creditoPeriodoDiaInput');
    const mesInput = document.getElementById('creditoPeriodoMesInput');
    const anoInput = document.getElementById('creditoPeriodoAnoInput');

    function digitsCap(el, len){
      const d = onlyDigits(el.value).slice(0, len);
      if (el.value !== d) el.value = d;
      return d;
    }

    if (tipoSel){
      // Trimestral/Anual ambíguo — seletor Trimestre/Ano.
      const trimGroup = document.getElementById('creditoPeriodoTrimestreGroup');
      function sync(){
        const isTrimestre = tipoSel.value === 'trimestre';
        trimGroup.style.display = isTrimestre ? 'inline-flex' : 'none';
        const ano = digitsCap(anoInput, 4);
        hidden.value = isTrimestre ? (ano.length === 4 ? (quarterSel.value + 'º Trimestre/' + ano) : '') : (ano.length === 4 ? ano : '');
      }
      tipoSel.addEventListener('change', sync);
      quarterSel.addEventListener('change', sync);
      anoInput.addEventListener('input', sync);
      anoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreditoForm(); });
      sync();
      return;
    }

    if (diaInput && mesInput && anoInput){
      // Conforme DARF (dd/mm/aaaa).
      function sync(){
        const dia = digitsCap(diaInput, 2), mes = digitsCap(mesInput, 2), ano = digitsCap(anoInput, 4);
        hidden.value = (dia.length === 2 && mes.length === 2 && ano.length === 4) ? (dia + '/' + mes + '/' + ano) : '';
      }
      [diaInput, mesInput, anoInput].forEach(el => { el.addEventListener('input', sync); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreditoForm(); }); });
      sync();
      return;
    }

    if (mesInput && anoInput){
      // Conforme retenção (mensal, mm/aaaa).
      function sync(){
        const mes = digitsCap(mesInput, 2), ano = digitsCap(anoInput, 4);
        hidden.value = (mes.length === 2 && ano.length === 4) ? (mes + '/' + ano) : '';
      }
      [mesInput, anoInput].forEach(el => { el.addEventListener('input', sync); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreditoForm(); }); });
      sync();
      return;
    }

    if (quarterSel && anoInput){
      // Trimestral (periodicidade única, sem ambiguidade).
      function sync(){
        const ano = digitsCap(anoInput, 4);
        hidden.value = ano.length === 4 ? (quarterSel.value + 'º Trimestre/' + ano) : '';
      }
      quarterSel.addEventListener('change', sync);
      anoInput.addEventListener('input', sync);
      anoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreditoForm(); });
      sync();
      return;
    }

    // 'livre': Anual (mascara-based, só dígitos) ou Conforme processo/desconhecido (sem
    // máscara nenhuma) — mesmo comportamento de sempre.
    hidden.addEventListener('input', (e) => {
      const mascara = creditoPeriodoMascara(tipoInputEl.value);
      e.target.value = aplicaCreditoPeriodoMascara(mascara, e.target.value);
    });
  }

  // Controle e acompanhamento de compensações: uma linha por débito compensado, só nos
  // PER/DCOMP de Compensação (os que usam o saldo de um crédito já constituído) — o
  // PER/DCOMP de Crédito (origem) não entra aqui, mesmo quando se autocompensa.
  function buildCompensacoesRows(pdfData){
    const rows = [];
    Object.values(pdfData).forEach(p => {
      // Só documentos de Compensação (referenciam um PER/DCOMP Inicial). O documento de
      // Crédito (origem), mesmo quando se autocompensa na própria declaração, fica de
      // fora — essa aba é só o controle das compensações propriamente ditas.
      if (classifyDocType(p) !== 'compensacao') return;
      const origem = p.perdcompInicial;
      // Crédito Selic: diferença entre o total dos débitos quitados e o total do crédito
      // ORIGINAL (sem correção) usado nesta DCOMP — é a parcela de Selic acumulada do
      // crédito que cobriu essa diferença.
      const creditoSelic = (p.totalDebitos != null && p.totalCreditoUtilizado != null) ? p.totalDebitos - p.totalCreditoUtilizado : null;
      (p.debitos || []).forEach(d => {
        rows.push({
          origem,
          perdcomp: p.numero,
          totalCreditoUtilizado: p.totalCreditoUtilizado,
          creditoSelic,
          dataCompensacao: p.dataTransmissao || '—',
          dataTs: p.dataTsRaw || 0,
          descricao: d.descricao || '—',
          principal: d.principal,
          multa: d.multa,
          juros: d.juros,
          total: d.total
        });
      });
    });
    return rows.sort((a,b) => b.dataTs - a.dataTs);
  }

  // PER/DCOMP de Compensação cujo "Nº do PER/DCOMP Inicial" (a origem, de Crédito) ainda
  // não tem PDF importado — sinaliza qual PDF de origem falta buscar.
  function buildCompensacoesSemOrigem(pdfData){
    const numeros = new Set(Object.keys(pdfData));
    return Object.values(pdfData)
      .filter(p => classifyDocType(p) === 'compensacao' && !numeros.has(p.perdcompInicial))
      .sort((a,b) => (b.dataTsRaw||0) - (a.dataTsRaw||0));
  }

  // ---------- Lançamentos contábeis (geração para importação no sistema Domínio) ----------
  // Cada débito compensado é mapeado para uma conta contábil de destino (ver
  // DEBITO_CONTA_RULES, testado contra "Grupo de Tributo" + "Código da Receita/Denominação").
  // "confirmed:true" = mapeamento validado com exemplos reais do cliente; "confirmed:false"
  // = sugestão por nome do tributo, ainda não confirmada — fica sinalizada na tela.
  // REGRA DE AGRUPAMENTO (confirmada com exemplo real): todos os débitos de um mesmo
  // documento que caem na mesma conta contábil viram UM ÚNICO lançamento, somados — não
  // um lançamento por débito individual (um PER/DCOMP com 9 débitos de contribuição
  // patronal/terceiros virou 1 lançamento só, na conta de INSS a Recolher). O valor desse
  // lançamento é só o Principal — Multa e Juros de mora de TODOS os débitos do documento
  // viram lançamentos à parte, em contas fixas (ver MULTA_JUROS_CONTAS), porque essas duas
  // contas nunca mudam com o tributo (confirmado com exemplo real do cliente).
  const DEBITO_CONTA_RULES = [
    { re: /\bcp\b/,                     conta:'191', nome:'INSS A RECOLHER',                    histLabel:'INSS',              confirmed:true },
    { re: /\birrf\b/,                   conta:'178', nome:'IRRF A RECOLHER',                     histLabel:'IRRF',              confirmed:true },
    { re: /\birpj\b/,                   conta:'178', nome:'IRRF A RECOLHER',                     histLabel:'IRRF',              confirmed:true },
    { re: /\bcsll\b/,                   conta:'177', nome:'CONTRIBUIÇÃO SOCIAL A RECOLHER',       histLabel:'CSLL',              confirmed:true },
    { re: /\bpis\b/,                    conta:'179', nome:'PIS A RECOLHER',                       histLabel:'PIS',               confirmed:false },
    { re: /\bcofins\b/,                 conta:'180', nome:'COFINS A RECOLHER',                    histLabel:'COFINS',            confirmed:false },
    { re: /\bicms\b/,                   conta:'172', nome:'ICMS A RECOLHER',                      histLabel:'ICMS',              confirmed:false },
    { re: /\bipi\b/,                    conta:'171', nome:'IPI A RECOLHER',                       histLabel:'IPI',               confirmed:false },
    { re: /\biss\b/,                    conta:'173', nome:'ISS A RECOLHER',                       histLabel:'ISS',               confirmed:false },
    { re: /\biof\b/,                    conta:'181', nome:'PROVISÃO PARA IOF',                    histLabel:'IOF',               confirmed:false },
    { re: /simples nacional/,           conta:'479', nome:'SIMPLES NACIONAL A RECOLHER',          histLabel:'SIMPLES NACIONAL',  confirmed:false },
    { re: /substituicao tributaria/,    conta:'481', nome:'SUBSTITUIÇÃO TRIBUTÁRIA A RECOLHER',   histLabel:'SUBST. TRIBUTÁRIA', confirmed:false },
    { re: /funrural/,                   conta:'490', nome:'FUNRURAL A RECOLHER',                  histLabel:'FUNRURAL',          confirmed:false },
    { re: /sindical/,                   conta:'491', nome:'CONTRIBUIÇÃO SINDICAL A RECOLHER',      histLabel:'CONTRIB. SINDICAL', confirmed:false }
  ];
  // Multa de mora e Juros passivos de um PER/DCOMP de compensação sempre vão pra essas duas
  // contas fixas, somados entre TODOS os débitos do documento — não dependem de qual
  // tributo foi compensado (confirmado com exemplo real do cliente, PERDCOMP
  // 29720.12097.120626.1.3.02-7124).
  const MULTA_JUROS_CONTAS = {
    multa: { conta:'352', nome:'MULTAS DE MORA', histLabel:'Multa de Mora' },
    juros: { conta:'368', nome:'JUROS PASSIVOS', histLabel:'Juros Passivos' }
  };
  // Conta de contrapartida (crédito) fixa por tipo de crédito do PER/DCOMP — também
  // confirmada com exemplo real só para "Saldo Negativo de IRPJ" até agora.
  const CREDITO_CONTA_RULES = [
    { re: /saldo negativo de irpj/, conta:'31', nome:'IRRF A RECUPERAR',                    confirmed:true },
    { re: /saldo negativo de csll/, conta:'33', nome:'CONTRIBUIÇÃO SOCIAL PAGA ESTIMATIVA', confirmed:false }
  ];
  // Crédito Selic ("Juros Ativos") — a diferença entre o total debitado no documento e o
  // Total do Crédito Original Utilizado extraído do PDF (o mesmo cálculo que já aparece
  // como "Crédito Selic" na aba Controle de compensações) — sempre vai pra essa conta fixa
  // quando houver. Conta 433 confirmada pelo usuário (era 3000 antes).
  const CREDITO_SELIC_CONTA = { conta:'433', nome:'JUROS ATIVOS' };
  // Listas completas pra seleção manual (dropdown) na tela, tiradas do plano de contas
  // enviado — grupo "170 S 2.1.2.01 Impostos e Contribuições a Recolher" (+ INSS/FGTS de
  // "190 S 2.1.3.02 Obrigações Sociais" + Multa/Juros de "3.3.2.03"/"3.3.3.01") pro lado do
  // débito, e "28 S 1.1.3.08 Tributos a Recuperar/Compensar" + Juros Selic de "3.4.1.02" pro
  // lado do crédito.
  const DEBITO_CONTA_OPTIONS = [
    ['171','IPI A RECOLHER'], ['172','ICMS A RECOLHER'], ['173','ISS A RECOLHER'],
    ['174','PROVISÃO PARA IMPOSTO DE RENDA'], ['175','PROVISÃO P/ CONTRIBUIÇÃO SOCIAL S/ LUCRO'],
    ['176','IMPOSTO DE RENDA A RECOLHER'], ['177','CONTRIBUIÇÃO SOCIAL A RECOLHER'],
    ['178','IRRF A RECOLHER'], ['179','PIS A RECOLHER'], ['180','COFINS A RECOLHER'],
    ['181','PROVISÃO PARA IOF'], ['182','CRF A RECOLHER'], ['183','ISS RETIDO A RECOLHER'],
    ['184','INSS RETIDO A RECOLHER'], ['191','INSS A RECOLHER'], ['192','FGTS A RECOLHER'],
    ['352','MULTAS DE MORA'], ['368','JUROS PASSIVOS'],
    ['479','SIMPLES NACIONAL A RECOLHER'], ['481','SUBSTITUIÇÃO TRIBUTÁRIA A RECOLHER'],
    ['483','REFIS A RECOLHER'], ['485','FIA A RECOLHER'], ['487','PIS RETIDO A RECOLHER'],
    ['488','COFINS RETIDO A RECOLHER'], ['489','CONTRIBUIÇÃO SOCIAL RETIDA A RECOLHER'],
    ['490','FUNRURAL A RECOLHER'], ['491','CONTRIBUIÇÃO SINDICAL A RECOLHER'],
    ['508','INSS RECEITA BRUTA A RECOLHER'], ['512','ICMS ANTECIPADO A RECOLHER'],
    ['513','ICMS ANTECIPAÇÃO TOTAL ST A RECOLHER']
  ];
  const CREDITO_CONTA_OPTIONS = [
    ['29','IPI A RECUPERAR'], ['30','ICMS A RECUPERAR'], ['31','IRRF A RECUPERAR'],
    ['32','IMPOSTO DE RENDA PAGO POR ESTIMATIVA'], ['33','CONTRIBUIÇÃO SOCIAL PAGA ESTIMATIVA'],
    ['34','TRIBUTOS PAGOS A MAIOR OU INDEVIDAMENTE'], ['35','CONTRIBUIÇÃO SOCIAL RETIDO A COMPENSAR'],
    ['36','COFINS RETIDO A COMPENSAR'], ['37','PIS RETIDO A COMPENSAR'], ['38','INSS A COMPENSAR'],
    ['39','BÔNUS DE ADIMPLÊNCIA FISCAL A COMPENSAR'], ['40','COFINS A RECUPERAR'], ['41','PIS A RECUPERAR'],
    ['42','COFINS A RECUPERAR-CRÉDITO PRESUMIDO'], ['43','PIS RECUPERAR-CRÉDITO PRESUMIDO'],
    ['433','JUROS ATIVOS']
  ];
  const ACCOUNT_NAME_BY_CODE = {};
  DEBITO_CONTA_OPTIONS.concat(CREDITO_CONTA_OPTIONS).forEach(([code,nome]) => { ACCOUNT_NAME_BY_CODE[code] = nome; });
  // Id de elemento DOM seguro a partir de uma chave qualquer (usado pra preservar o foco
  // do campo de Complemento Histórico entre re-renders — ver renderMain()).
  function domSafeId(prefix, key){ return prefix + '_' + String(key).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function matchTributoConta(d){
    const hay = normalize(`${d.grupoTributo||''} ${d.descricao||''}`);
    return DEBITO_CONTA_RULES.find(r => r.re.test(hay)) || null;
  }
  function matchCreditoConta(tipoCredito){
    const hay = normalize(tipoCredito||'');
    return CREDITO_CONTA_RULES.find(r => r.re.test(hay)) || null;
  }
  const MESES_PT = { janeiro:'01', fevereiro:'02', marco:'03', abril:'04', maio:'05', junho:'06', julho:'07', agosto:'08', setembro:'09', outubro:'10', novembro:'11', dezembro:'12' };
  // Converte o texto de "Período de Apuração" do débito (ex.: "Julho de 2026" ou já
  // "07/2026") em "mm/aaaa", pra usar no Complemento Histórico — sempre a partir do
  // período real do débito, nunca digitado à mão (evita repetir erro de digitação).
  function periodoToMonthYear(periodoStr){
    const raw = String(periodoStr || '');
    const direct = raw.match(/(\d{2})\/(\d{4})/);
    if (direct) return direct[1] + '/' + direct[2];
    const n = normalize(raw);
    const year = n.match(/(\d{4})/);
    const mesKey = Object.keys(MESES_PT).find(mes => n.includes(mes));
    return (mesKey && year) ? MESES_PT[mesKey] + '/' + year[1] : '';
  }
  function buildLancamentos(pdfData, client, overrides){
    overrides = overrides || { debito:{}, credito:{}, complemento:{}, codHistorico:{}, iniciaLote:{}, matrizFilial:{}, centroCustoDebito:{}, centroCustoCredito:{} };
    const rows = [];
    const naoMapeados = []; // débitos sem conta contábil reconhecida
    Object.values(pdfData).forEach(p => {
      if (classifyDocType(p) !== 'compensacao') return;
      const creditoRule = matchCreditoConta(p.tipoCredito);

      // ---- Baldes de DÉBITO: um por conta de tributo (só o Principal — Multa e Juros são
      // baldes à parte, em contas fixas), mais Multa e Juros somados de todos os débitos
      // que tiveram a conta de tributo reconhecida (um débito não mapeado — ver
      // naoMapeados — não entra em nenhum lançamento, nem no principal nem na multa/juros
      // dele, igual já acontecia antes). ----
      const gruposTributo = {};
      (p.debitos || []).forEach(d => {
        const rule = matchTributoConta(d);
        if (!rule){
          naoMapeados.push({ perdcomp: p.numero, grupoTributo: d.grupoTributo, descricao: d.descricao, total: d.total || 0 });
          return;
        }
        (gruposTributo[rule.conta] = gruposTributo[rule.conta] || { rule, items: [] }).items.push(d);
      });
      const mappedItems = Object.values(gruposTributo).flatMap(g => g.items);
      const debitBuckets = Object.values(gruposTributo).map(g => ({
        conta: g.rule.conta,
        nome: g.rule.nome,
        histLabel: g.rule.histLabel,
        confirmed: g.rule.confirmed,
        valor: g.items.reduce((s,d) => s + (d.principal || 0), 0),
        periodo: g.items.map(d => d.periodoApuracao).find(Boolean) || '',
        qtdDebitos: g.items.length,
        tipoBalde: 'tributo'
      })).filter(b => b.valor > 0.004);
      const periodoDoc = mappedItems.map(d => d.periodoApuracao).find(Boolean) || '';
      const multaTotal = mappedItems.reduce((s,d) => s + (d.multa || 0), 0);
      const jurosTotal = mappedItems.reduce((s,d) => s + (d.juros || 0), 0);
      if (multaTotal > 0.004){
        debitBuckets.push({ conta: MULTA_JUROS_CONTAS.multa.conta, nome: MULTA_JUROS_CONTAS.multa.nome, histLabel: MULTA_JUROS_CONTAS.multa.histLabel, confirmed:true, valor: multaTotal, periodo: periodoDoc, qtdDebitos: mappedItems.filter(d => (d.multa||0) > 0.004).length, tipoBalde:'multa' });
      }
      if (jurosTotal > 0.004){
        debitBuckets.push({ conta: MULTA_JUROS_CONTAS.juros.conta, nome: MULTA_JUROS_CONTAS.juros.nome, histLabel: MULTA_JUROS_CONTAS.juros.histLabel, confirmed:true, valor: jurosTotal, periodo: periodoDoc, qtdDebitos: mappedItems.filter(d => (d.juros||0) > 0.004).length, tipoBalde:'juros' });
      }
      // Ordem estável por número da conta — igual à ordem em que "Object.values" já
      // devolvia as contas de tributo antes (chaves numéricas em string ordenam assim em JS).
      debitBuckets.sort((a,b) => Number(a.conta) - Number(b.conta));
      if (!debitBuckets.length) return;

      // ---- Baldes de CRÉDITO: o crédito original utilizado (regra por tipo de crédito,
      // valor = "Total do Crédito Original Utilizado" extraído do PDF) e, quando houver, o
      // Crédito Selic (diferença entre o total debitado do documento e esse valor — mesmo
      // cálculo já usado na aba Controle de compensações). ----
      const creditBuckets = [];
      if (p.totalCreditoUtilizado != null && p.totalCreditoUtilizado > 0.004){
        creditBuckets.push({
          conta: creditoRule ? creditoRule.conta : '',
          nome: creditoRule ? creditoRule.nome : '',
          confirmed: !!(creditoRule && creditoRule.confirmed),
          valor: p.totalCreditoUtilizado,
          tipoBalde: 'credito-original'
        });
      }
      const creditoSelic = (p.totalDebitos != null && p.totalCreditoUtilizado != null) ? (p.totalDebitos - p.totalCreditoUtilizado) : null;
      if (creditoSelic != null && creditoSelic > 0.004){
        creditBuckets.push({ conta: CREDITO_SELIC_CONTA.conta, nome: CREDITO_SELIC_CONTA.nome, confirmed:true, valor: creditoSelic, tipoBalde:'selic' });
      }
      // Nenhuma conta de crédito reconhecida ainda pra esse documento (não achou nem o
      // crédito original nem deu pra calcular o Selic): mantém o comportamento de antes,
      // um balde só sem conta, pra sinalizar "⚠ não configurada" na tela.
      if (!creditBuckets.length && p.totalDebitos != null && p.totalDebitos > 0.004){
        creditBuckets.push({ conta:'', nome:'', confirmed:false, valor: p.totalDebitos, tipoBalde:'nenhuma' });
      }

      // Complemento Histórico por LINHA — o texto padrão depende do papel da conta nessa
      // linha (confirmado com o usuário, pelo nome da própria conta): o tributo principal
      // e o crédito original levam "Vr. Compensado..."; a Multa leva "Vr. Multa..."; Juros
      // Passivos (débito) e Juros Ativos/Selic (crédito, conta 433) levam "Vr. Juros...".
      // Cada linha continua editável individualmente (ver overrides.complemento).
      function defaultComplementoFor(bucket){
        if (bucket.tipoBalde === 'multa') return `Vr. Multa cfe. Perdcomp ${p.numero}.`;
        if (bucket.tipoBalde === 'juros' || bucket.tipoBalde === 'selic') return `Vr. Juros cfe. Perdcomp ${p.numero}.`;
        // 'tributo' (principal), 'credito-original' e qualquer balde sem papel específico
        // ('nenhuma') caem no padrão "compensado".
        return `Vr. Compensado cfe. Perdcomp ${p.numero}.`;
      }

      // Uma linha por BALDE — nunca débito e crédito juntos na mesma linha (o formato do
      // Domínio aceita isso: cada linha usa só um lado, e o total de débito bate com o
      // total de crédito olhando o documento inteiro). Também confirmado com o mesmo
      // exemplo real: a planilha do cliente tem 5 linhas — 3 de débito (191/352/368) e 2 de
      // crédito (31/3000) — cada uma com só a conta débito OU só a conta crédito preenchida.
      //
      // Inicia Lote: melhor hipótese com um único exemplo confirmado até agora — 1 na linha
      // do tributo principal e na linha de Crédito Selic (quando houver), 0 nas demais.
      // Continua editável linha a linha (ver overrides.iniciaLote) caso outro exemplo real
      // mostre uma regra diferente.
      function pushLancamentoRow(bucket, lado){
        const groupKey = p.numero + '::' + lado + '::' + bucket.conta;
        const debitoOverride = lado === 'debito' ? overrides.debito[groupKey] : undefined;
        const creditoOverride = lado === 'credito' ? overrides.credito[groupKey] : undefined;
        const complementoOverride = overrides.complemento[groupKey];
        // Cód. Histórico, Inicia Lote, Matriz/Filial e os Centros de Custo também viram
        // correções por lançamento (mesma chave groupKey) — (overrides.<campo> || {}) porque
        // config salva antes dessas colunas existirem pode não ter o balde ainda, mesmo já
        // mesclado com o padrão no carregamento (ver loadRecordsForSelected).
        const codHistoricoOverride = (overrides.codHistorico || {})[groupKey];
        const iniciaLoteOverride = (overrides.iniciaLote || {})[groupKey];
        const matrizFilialOverride = (overrides.matrizFilial || {})[groupKey];
        const centroCustoDebitoOverride = (overrides.centroCustoDebito || {})[groupKey];
        const centroCustoCreditoOverride = (overrides.centroCustoCredito || {})[groupKey];
        // O lado que esta linha NÃO usa (ex.: a conta de crédito numa linha de débito) fica
        // em branco por padrão, de propósito (ver nota acima sobre 1 linha por balde) — mas
        // o usuário pode preencher à mão se achar necessário pro jeito que ele escritura
        // (ex.: o sistema contábil dele espera as duas pontas na mesma linha). Um simples
        // campo de texto, não uma lista/sugestão — é um preenchimento manual opcional.
        const debitoExtraOverride = (overrides.debitoExtra || {})[groupKey];
        const creditoExtraOverride = (overrides.creditoExtra || {})[groupKey];

        // Uma correção manual (debitoOverride/creditoOverride) normalmente é só o código
        // de uma conta da lista (DEBITO_CONTA_OPTIONS/CREDITO_CONTA_OPTIONS) — uma string.
        // Quando o plano de contas do cliente é diferente e nenhuma conta da lista serve,
        // o usuário pode digitar código+nome à mão ("Outra conta"): aí a correção vira um
        // objeto {conta, nome} em vez de string, e o nome exibido vem do que foi digitado,
        // não da lista fixa (ver ACCOUNT_NAME_BY_CODE, que só conhece as contas da lista).
        const debitoCustom = lado === 'debito' && debitoOverride && typeof debitoOverride === 'object';
        const creditoCustom = lado === 'credito' && creditoOverride && typeof creditoOverride === 'object';
        const contaDebito = lado === 'debito' ? (debitoCustom ? (debitoOverride.conta || '') : (debitoOverride || bucket.conta)) : (debitoExtraOverride || '');
        const contaCredito = lado === 'credito' ? (creditoCustom ? (creditoOverride.conta || '') : (creditoOverride || bucket.conta)) : (creditoExtraOverride || '');
        const iniciaLoteDefault = (bucket.tipoBalde === 'tributo' || bucket.tipoBalde === 'selic') ? '1' : '0';

        rows.push({
          groupKey,
          lado, // 'debito' | 'credito' — qual lado esta linha usa
          data: p.dataTransmissao || '',
          dataTs: p.dataTsRaw || 0,
          // Data de Criação do PER/DCOMP — usada só pro filtro de período da aba; docs
          // importados antes desse campo existir caem de volta na Data de Transmissão.
          dataCriacaoTs: p.dataCriacaoTsRaw || p.dataTsRaw || 0,
          dataCriacaoDisplay: p.dataCriacao || p.dataTransmissao || '—',
          perdcomp: p.numero,
          origem: p.perdcompInicial,
          tipoCredito: p.tipoCredito || '',
          contaDebito,
          contaDebitoNome: lado === 'debito' ? (debitoCustom ? (debitoOverride.nome || '') : (ACCOUNT_NAME_BY_CODE[contaDebito] || bucket.nome)) : '',
          debitoConfirmado: lado === 'debito' ? (!!debitoOverride || bucket.confirmed) : true,
          debitoCustom,
          contaCredito,
          contaCreditoNome: lado === 'credito' ? (creditoCustom ? (creditoOverride.nome || '') : (contaCredito ? (ACCOUNT_NAME_BY_CODE[contaCredito] || bucket.nome) : '')) : '',
          creditoConfirmado: lado === 'credito' ? (!!creditoOverride || !!bucket.confirmed) : true,
          creditoCustom,
          valor: bucket.valor,
          codHistorico: codHistoricoOverride != null ? codHistoricoOverride : '0',
          complemento: complementoOverride != null ? complementoOverride : defaultComplementoFor(bucket),
          iniciaLote: iniciaLoteOverride != null ? iniciaLoteOverride : iniciaLoteDefault,
          matrizFilial: matrizFilialOverride != null ? matrizFilialOverride : ((client && client.codMatrizFilial) || ''),
          centroCustoDebito: centroCustoDebitoOverride != null ? centroCustoDebitoOverride : '0',
          centroCustoCredito: centroCustoCreditoOverride != null ? centroCustoCreditoOverride : '0',
          qtdDebitos: bucket.qtdDebitos
        });
      }

      debitBuckets.forEach(b => pushLancamentoRow(b, 'debito'));
      creditBuckets.forEach(b => pushLancamentoRow(b, 'credito'));
    });
    rows.sort((a,b) => b.dataTs - a.dataTs);
    return { rows, naoMapeados };
  }
  function fmtNumTxt(n){ return (n || 0).toFixed(2).replace('.', ','); }
  // Formato de exportação confirmado com o próprio arquivo gerado pela macro do Domínio
  // (lanctos.txt): uma linha por lançamento, campos separados por ";", decimal com
  // vírgula, quebra de linha CRLF, sem cabeçalho. O download em si passa pela capability
  // "downloads" do Artifact — a página não consegue disparar um download sozinha.
  async function exportLancamentosTxt(rows, client){
    // Cada linha usa só um lado (débito OU crédito) — só precisa desse lado preenchido
    // pra exportar, não os dois juntos (ver buildLancamentos).
    const usable = rows.filter(r => r.contaCredito || r.contaDebito);
    const lines = usable.map(r => [
      r.data || '', r.contaDebito || '', r.contaCredito || '', fmtNumTxt(r.valor),
      r.codHistorico || '0', r.complemento || '', r.iniciaLote || '0',
      r.matrizFilial || '', r.centroCustoDebito || '0', r.centroCustoCredito || '0'
    ].join(';'));
    const content = lines.join('\r\n') + (lines.length ? '\r\n' : '');
    const filename = 'lancamentos' + (client && client.slug ? '-' + client.slug : '') + '.txt';
    const downloads = await getDownloads();
    if (!downloads){
      state.lancMsg = { text:'Não consegui abrir o download aqui. Tente novamente, ou avise se isso persistir.', kind:'err' };
      renderMain();
      return;
    }
    try{
      await downloads.save({ filename, data: content });
      state.lancMsg = { text:'Arquivo "' + filename + '" baixado.', kind:'ok' };
    }catch(e){
      if (e && e.code === 'declined'){
        state.lancMsg = null; // usuário só cancelou o download, sem precisar de aviso
      } else {
        console.error(e);
        state.lancMsg = { text:'Não consegui gerar o download (' + (e && e.message ? e.message : 'erro desconhecido') + ').', kind:'err' };
      }
    }
    renderMain();
  }

  // ---------- Relatório em PDF da aba "Controle de compensações" ----------
  // Usa jsPDF + jspdf-autotable (carregados via <script> no <head>) pra montar um PDF com
  // a identidade visual do painel, respeitando os filtros (origem/competência) já aplicados
  // na tela. O PDF é entregue via capability "downloads" — igual ao .txt de Lançamentos.
  async function generateCompensacoesReport(rows, totals, client, filters){
    if (!(window.jspdf && window.jspdf.jsPDF)){
      state.compReportMsg = { text:'Não consegui carregar a biblioteca de PDF agora. Recarregue a página e tente de novo.', kind:'err' };
      renderMain();
      return;
    }
    if (!rows.length){
      state.compReportMsg = { text:'Nenhuma compensação no filtro atual pra incluir no relatório.', kind:'err' };
      renderMain();
      return;
    }
    try{
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation:'landscape', unit:'pt', format:'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const MARGIN = 36;

      const filtroDesc = [
        filters.busca ? ('PERDCOMP contém "' + filters.busca + '"') : 'Todos os PER/DCOMP',
        (filters.from || filters.to) ? ('Competência ' + (filters.from || '—') + ' a ' + (filters.to || '—')) : 'Todas as competências'
      ].join('   ·   ');

      const now = new Date();
      const genDateStr = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

      // Cabeçalho (faixa escura + linha do cliente) e rodapé (linha + "Gerado em") — desenhados
      // direto na página 1 antes da tabela, e de novo em cada página nova que a tabela abrir.
      function drawChrome(){
        doc.setFillColor(18,24,34);
        doc.rect(0,0,pageW,42,'F');
        doc.setTextColor(201,154,75);
        doc.setFont('helvetica','bold'); doc.setFontSize(13);
        doc.text('Conttinova', MARGIN, 27);
        doc.setTextColor(230,227,214);
        doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
        doc.text('Relatório de Controle de Compensações', pageW-MARGIN, 17, { align:'right' });
        doc.text(client.name + (client.cnpj ? ('   ·   CNPJ ' + formatCnpj(client.cnpj)) : ''), pageW-MARGIN, 28, { align:'right' });

        doc.setDrawColor(220,220,220);
        doc.setLineWidth(0.5);
        doc.line(MARGIN, pageH-30, pageW-MARGIN, pageH-30);
        doc.setTextColor(140,140,140);
        doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
        doc.text('Painel PER/DCOMP · Conttinova   ·   Gerado em ' + genDateStr, MARGIN, pageH-18);
      }

      drawChrome();
      let y = 64;
      doc.setTextColor(30,30,30);
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5);
      doc.text(filtroDesc, MARGIN, y);
      y += 18;

      // Cartões de resumo (mesma ideia dos "stamps" da tela: valor grande + rótulo, com
      // uma faixa em brass no topo pra puxar a identidade visual do painel pro papel).
      const kpis = [
        { label:'Compensações no período', value: String(rows.length) },
        { label:'Crédito utilizado', value: fmtBRL(totals.creditoUtilizado) },
        { label:'Crédito Selic', value: fmtBRL(totals.creditoSelic) },
        { label:'Total (principal+multa+juros)', value: fmtBRL(totals.total) }
      ];
      const gap = 10;
      const kpiW = (pageW - MARGIN*2 - (kpis.length-1)*gap) / kpis.length;
      kpis.forEach((k,i) => {
        const x = MARGIN + i*(kpiW+gap);
        doc.setFillColor(247,245,239);
        doc.setDrawColor(226,220,203);
        doc.roundedRect(x, y, kpiW, 44, 3, 3, 'FD');
        doc.setFillColor(201,154,75);
        doc.rect(x, y, kpiW, 2.5, 'F');
        doc.setTextColor(120,110,90);
        doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
        doc.text(k.label.toUpperCase(), x+8, y+17);
        doc.setTextColor(30,30,30);
        doc.setFont('helvetica','bold'); doc.setFontSize(13);
        doc.text(k.value, x+8, y+34);
      });
      y += 44 + 16;

      const head = [[
        'Nº PER/DCOMP inicial','PERDCOMP','Data comp.','Créd. utilizado','Créd. Selic','Principal','Multa','Juros','Total','Descrição'
      ]];
      // Mesmo PERDCOMP nunca muda de origem/data/créd.utilizado/créd.selic entre os débitos
      // dele — mescla essas colunas com rowSpan (igual ao rowspan já usado na tabela em tela,
      // ver "compRowsGrouped") em vez de repetir o mesmo valor em toda linha de débito.
      const body = rows.map(r => {
        if (r.isFirst){
          return [
            { content: r.origem, rowSpan: r.rowspan },
            { content: r.perdcomp, rowSpan: r.rowspan },
            { content: r.dataCompensacao, rowSpan: r.rowspan },
            { content: fmtBRL(r.totalCreditoUtilizado), rowSpan: r.rowspan },
            { content: fmtBRL(r.creditoSelic), rowSpan: r.rowspan },
            fmtBRL(r.principal), fmtBRL(r.multa), fmtBRL(r.juros), fmtBRL(r.total), r.descricao
          ];
        }
        return [ fmtBRL(r.principal), fmtBRL(r.multa), fmtBRL(r.juros), fmtBRL(r.total), r.descricao ];
      });

      doc.autoTable({
        head, body,
        startY: y,
        margin: { top: 50, bottom: 40, left: MARGIN, right: MARGIN },
        rowPageBreak: 'avoid', // nunca corta uma linha (nem um grupo mesclado) no meio entre páginas
        styles: { font:'helvetica', fontSize:7.5, cellPadding:{top:4,right:5,bottom:4,left:5}, textColor:[40,40,40], lineColor:[226,220,203], lineWidth:0.5, overflow:'linebreak', valign:'top' },
        headStyles: { fillColor:[26,34,45], textColor:[234,229,214], fontStyle:'bold', halign:'left', fontSize:7.5 },
        alternateRowStyles: { fillColor:[247,245,239] },
        columnStyles: {
          2: { cellWidth: 48 },
          3: { cellWidth: 74, halign:'right', font:'courier' },
          4: { cellWidth: 68, halign:'right', font:'courier' },
          5: { cellWidth: 68, halign:'right', font:'courier' },
          6: { cellWidth: 56, halign:'right', font:'courier' },
          7: { cellWidth: 56, halign:'right', font:'courier' },
          8: { cellWidth: 72, halign:'right', font:'courier', fontStyle:'bold' }
        },
        didDrawPage: (data) => { if (data.pageNumber > 1) drawChrome(); }
      });

      // Só dá pra saber o total de páginas depois de desenhar tudo — corrige o rodapé de
      // todas elas numa segunda passada, em vez de tentar adivinhar durante o desenho.
      const totalPages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++){
        doc.setPage(p);
        doc.setTextColor(140,140,140);
        doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
        doc.text('Página ' + p + ' de ' + totalPages, pageW-MARGIN, pageH-18, { align:'right' });
      }

      const blob = doc.output('blob');
      const filename = 'relatorio-compensacoes' + (client && client.slug ? '-' + client.slug : '') + '.pdf';
      const downloads = await getDownloads();
      if (!downloads){
        state.compReportMsg = { text:'Não consegui abrir o download aqui. Tente novamente, ou avise se isso persistir.', kind:'err' };
        renderMain();
        return;
      }
      try{
        await downloads.save({ filename, data: blob });
        state.compReportMsg = { text:'Relatório "' + filename + '" gerado.', kind:'ok' };
      }catch(e){
        if (e && e.code === 'declined'){
          state.compReportMsg = null; // usuário só cancelou o download
        } else {
          console.error(e);
          state.compReportMsg = { text:'Não consegui gerar o download (' + (e && e.message ? e.message : 'erro desconhecido') + ').', kind:'err' };
        }
      }
    }catch(e){
      console.error(e);
      state.compReportMsg = { text:'Não consegui montar o relatório (' + (e && e.message ? e.message : 'erro desconhecido') + ').', kind:'err' };
    }
    renderMain();
  }

  function esc(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderDbBanner(){
    const el = document.getElementById('dbBanner');
    if (!el) return;
    el.innerHTML = state.dbAvailable === false
      ? `<div class="db-banner">⚠ Não consegui conectar ao banco de dados compartilhado deste painel — o que você fizer agora não vai ficar salvo. Recarregue a página; se persistir, avise quem cuida do painel.</div>`
      : '';
  }

  function render(){
    renderDbBanner();
    renderSidebar();
    renderMain();
  }

  function renderSidebar(){
    const list = document.getElementById('clientList');
    if (!state.clients.length){
      list.innerHTML = '<li class="empty-clients">Nenhum cliente cadastrado ainda. Adicione um acima para começar a organizar as compensações.</li>';
      return;
    }
    list.innerHTML = state.clients.map(c => `
      <li class="client-item ${c.slug===state.selectedSlug?'active':''}" data-slug="${esc(c.slug)}">
        <span class="dot"></span>
        <span class="name">${esc(c.name)}${!c.cnpj ? '<span title="CNPJ não cadastrado — importações não serão conferidas" style="color:var(--andamento);margin-left:5px;">⚠</span>' : ''}</span>
        <span class="count">${c.count||0}</span>
        <button class="edit" data-edit="${esc(c.slug)}" title="Editar cadastro">✎</button>
        <button class="del" data-del="${esc(c.slug)}" title="Remover cliente">✕</button>
      </li>
    `).join('');
    list.querySelectorAll('.client-item').forEach(el => {
      el.addEventListener('click', () => selectClient(el.dataset.slug));
    });
    list.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); openClientModal(el.dataset.edit); });
    });
    list.querySelectorAll('[data-del]').forEach(el => {
      el.addEventListener('click', (ev) => deleteClient(el.dataset.del, ev));
    });
  }

  // renderMain reconstrói todo o HTML do painel a cada mudança (filtros, abas, etc.) —
  // isso destrói e recria os próprios campos de filtro no meio da digitação, fazendo o
  // navegador perder o foco (e, num <input type="date">, perder o segmento que estava
  // sendo preenchido — por isso o campo "parece dar erro" bem na hora de digitar o ano,
  // que é o último segmento preenchido e o que mais often completa a data e dispara
  // o 'change'). Esse wrapper guarda qual campo estava focado (e a posição do cursor,
  // quando aplicável) antes de reconstruir o HTML, e devolve o foco a ele depois.
  function renderMain(){
    const mainEl = document.getElementById('mainArea');
    const active = document.activeElement;
    const activeId = (active && active.id && mainEl && mainEl.contains(active)) ? active.id : null;
    let selStart = null, selEnd = null;
    if (activeId && typeof active.selectionStart === 'number'){
      try{ selStart = active.selectionStart; selEnd = active.selectionEnd; }catch(e){}
    }

    renderMainInner();

    if (activeId){
      const el = document.getElementById(activeId);
      if (el){
        el.focus({ preventScroll:true });
        if (selStart != null && typeof el.setSelectionRange === 'function'){
          try{ el.setSelectionRange(selStart, selEnd); }catch(e){}
        }
      }
    }
  }

  function renderMainInner(){
    const main = document.getElementById('mainArea');
    const client = state.clients.find(c => c.slug === state.selectedSlug);

    if (!client){
      main.innerHTML = `
        <div class="main-header">
          <div><h2>Painel de compensações</h2><div class="sub">Organize os PER/DCOMP já transmitidos, por cliente.</div></div>
        </div>
        <div class="no-client">
          <div class="big">Nenhum cliente selecionado</div>
          Cadastre um cliente na barra lateral e importe a planilha "Consulta Processamento PER/DCOMP" da Receita Federal.
        </div>`;
      return;
    }

    const filtered = applyFilters(state.records);

    const creditoOpts = distinctSorted(state.records, 'tipoCredito');
    const docOpts = distinctSorted(state.records, 'tipoDocumento');
    const situacaoOpts = distinctSorted(state.records, 'situacao');
    const naturezaPresentes = new Set(state.records.map(r => classifyDocType(state.pdfData[r.numero])).filter(Boolean));
    const naturezaOpts = ['credito','compensacao'].filter(k => naturezaPresentes.has(k));

    const creditRoots = computeCreditRoots(state.pdfData);
    const totalDisponivel = creditRoots.reduce((s,r) => s + (r.saldoAtual||0), 0);

    const compRowsAll = buildCompensacoesRows(state.pdfData);
    // Filtro por nº de PER/DCOMP — casa tanto a Origem (Nº PER/DCOMP inicial) quanto a
    // Compensação (coluna PERDCOMP), busca parcial e ignorando acentuação/caixa.
    const compBusca = normalize(state.compFilters.busca || '');
    // Filtro por competência (mês/ano) da Data da Compensação — não é a data exata, é o
    // mês/ano dela (ex.: 07/2026 a 08/2026 pega tudo compensado nesses dois meses).
    const compFromKey = monthYearToKey(state.compFilters.from);
    const compToKey = monthYearToKey(state.compFilters.to);
    const compRows = compRowsAll.filter(r => {
      if (compBusca && !normalize(r.origem).includes(compBusca) && !normalize(r.perdcomp).includes(compBusca)) return false;
      if (compFromKey != null || compToKey != null){
        const d = r.dataTs ? new Date(r.dataTs) : null;
        const rowKey = d ? (d.getFullYear() * 12 + d.getMonth()) : null;
        if (rowKey == null) return false;
        if (compFromKey != null && rowKey < compFromKey) return false;
        if (compToKey != null && rowKey > compToKey) return false;
      }
      return true;
    });
    const compTotals = compRows.reduce((s,r) => ({
      principal: s.principal + (r.principal||0), multa: s.multa + (r.multa||0),
      juros: s.juros + (r.juros||0), total: s.total + (r.total||0)
    }), { principal:0, multa:0, juros:0, total:0 });
    // Créd. utilizado no doc. e Crédito Selic são valores por DOCUMENTO, repetidos em cada
    // linha de débito — somar uma vez por PERDCOMP distinto para não multiplicar o total.
    const compDocSeen = new Map();
    compRows.forEach(r => { if (!compDocSeen.has(r.perdcomp)) compDocSeen.set(r.perdcomp, r); });
    compTotals.creditoUtilizado = [...compDocSeen.values()].reduce((s,r) => s + (r.totalCreditoUtilizado||0), 0);
    compTotals.creditoSelic = [...compDocSeen.values()].reduce((s,r) => s + (r.creditoSelic||0), 0);
    // Agrupa linhas consecutivas do mesmo PERDCOMP para mesclar (rowspan) as colunas
    // no nível do documento, evitando repetir os mesmos valores visualmente a cada débito.
    const compRowsGrouped = compRows.map((r,i) => {
      const isFirst = i===0 || compRows[i-1].perdcomp !== r.perdcomp;
      let rowspan = 1;
      if (isFirst) { for (let j=i+1;j<compRows.length && compRows[j].perdcomp===r.perdcomp;j++) rowspan++; }
      return { ...r, isFirst, rowspan, isGroupBoundary: isFirst && i>0 };
    });

    const semOrigem = buildCompensacoesSemOrigem(state.pdfData);
    const lancData = buildLancamentos(state.pdfData, client, state.lancOverrides);
    const lancRows = lancData.rows;
    const lancNaoMapeados = lancData.naoMapeados;
    // Filtro por Data de Criação do PER/DCOMP (dd/mm/aaaa "De"/"Até") — mesma máscara e
    // conversão usadas no filtro de datas da aba Registros.
    const lancFromIso = dateBrToIso(state.lancFilters.from);
    const lancToIso = dateBrToIso(state.lancFilters.to);
    const lancFromTs = lancFromIso ? new Date(lancFromIso).getTime() : null;
    const lancToTs = lancToIso ? new Date(lancToIso).getTime() + 86399999 : null; // fim do dia
    // Filtro por Nº PER/DCOMP — mesmo padrão de busca parcial, ignorando acentuação/caixa,
    // já usado na aba Controle de compensações (ver compBusca acima).
    const lancBusca = normalize(state.lancFilters.busca || '');
    const lancRowsFiltered = lancRows.filter(r => {
      if (lancFromTs != null && r.dataCriacaoTs < lancFromTs) return false;
      if (lancToTs != null && r.dataCriacaoTs > lancToTs) return false;
      if (lancBusca && !normalize(r.perdcomp).includes(lancBusca)) return false;
      return true;
    });
    // Cada linha usa só um lado (débito OU crédito) — só sinaliza "sem conta" pro lado que
    // essa linha realmente usa, não pro lado que já é esperado ficar em branco.
    const lancSemCredito = lancRowsFiltered.filter(r => r.lado === 'credito' && !r.contaCredito).length;
    const lancSemDebito = lancRowsFiltered.filter(r => r.lado === 'debito' && !r.contaDebito).length;

    // Situação (calculada, nunca digitada) de cada lançamento manual da aba "Controle de
    // crédito" — comparada contra as origens de crédito já identificadas nos PER/DCOMP
    // importados (creditRoots, computado acima).
    const creditoEntriesView = state.creditoEntries.map(c => ({ ...c, situacao: creditoSituacao(c, creditRoots) }));
    // Crédito Disponível – Não Informado: soma do Valor original de todo lançamento manual
    // (Controle de crédito) cuja Situação é "disponível" — crédito já sabido pela contabilidade
    // mas que ainda não apareceu em nenhum PER/DCOMP importado. Saldo Total Disponível soma
    // esse valor ao crédito já rastreado a partir dos PDFs (totalDisponivel).
    const totalDisponivelNaoInformado = creditoEntriesView.reduce((s,c) => s + (c.situacao === 'disponivel' ? (c.valorOriginal||0) : 0), 0);
    const saldoTotalDisponivel = totalDisponivel + totalDisponivelNaoInformado;

    main.innerHTML = `
      <div class="main-header">
        <div>
          <h2>${esc(client.name)}</h2>
          <div class="sub">${state.records.length} PER/DCOMP registrado(s) &nbsp;·&nbsp; <b>Livro de Protocolo</b>${client.cnpj ? ` &nbsp;·&nbsp; CNPJ ${esc(formatCnpj(client.cnpj))}` : ` &nbsp;·&nbsp; <span style="color:var(--andamento);cursor:pointer;" id="cnpjMissingLink">⚠ CNPJ não cadastrado — importações não serão conferidas. Cadastrar agora</span>`}</div>
        </div>
        <div class="upload-wrap">
          ${state.uploadMsg ? `<div class="upload-msg ${state.uploadMsg.kind}">${esc(state.uploadMsg.text)}</div>` : ''}
          <button class="upload-btn secondary" id="uploadPdfBtn">⭱ Importar PDF(s)</button>
          <button class="upload-btn" id="uploadBtn">⭱ Gerar lançamentos contábeis</button>
        </div>
      </div>

      ${(creditRoots.length || state.creditoEntries.length) ? `
      <div class="credit-banner">
        <div class="cb-row">
          <div class="cb-stat">
            <div class="cb-label">Crédito disponível para compensação/restituição</div>
            <div class="cb-value">${fmtBRL(totalDisponivel)}</div>
          </div>
          <div class="cb-stat">
            <div class="cb-label">Crédito disponível — não informado</div>
            <div class="cb-value" style="color:var(--brass)">${fmtBRL(totalDisponivelNaoInformado)}</div>
          </div>
          <div class="cb-stat">
            <div class="cb-label">Saldo total disponível</div>
            <div class="cb-value">${fmtBRL(saldoTotalDisponivel)}</div>
          </div>
        </div>
      </div>

      <div class="table-wrap credit-roots">
        <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Origem do crédito</th><th>Tipo de crédito</th><th>Período do crédito</th><th style="text-align:right">Valor original</th><th style="text-align:right">Saldo disponível</th><th style="text-align:right">Compensações</th>
          </tr></thead>
          <tbody>
          ${creditRoots.map(r => `
            <tr class="has-pdf" data-open-root="${esc(r.root)}">
              <td class="num">${esc(r.root)}${!r.origemImportada ? '<span class="badge" style="margin-left:8px;color:var(--andamento);border-color:var(--andamento);background:transparent;font-size:9.5px;" title="O PER/DCOMP que constituiu este crédito ainda não foi importado — saldo calculado só a partir das compensações.">origem não importada</span>' : ''}${r.outrasEmpresas.length ? '<span class="badge" style="margin-left:6px;color:var(--neg);border-color:var(--neg);background:transparent;font-size:9.5px;" title="Documento(s) de outro CNPJ encontrados e excluídos deste cálculo">⚠ outro CNPJ</span>' : ''}</td>
              <td>${esc(r.tipoCredito||'—')}</td>
              <td>${esc(r.periodoCredito||'—')}</td>
              <td class="val">${fmtBRL(r.valorOriginal)}</td>
              <td class="val" style="color:var(--pos);font-weight:600;">${fmtBRL(r.saldoAtual)}${r.saldoEstimado?' *':''}</td>
              <td class="val">${r.qtdCompensacoes}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </div>
      ` : ''}

      <div class="tabs">
        <button class="tab-btn ${state.activeTab==='registros'?'active':''}" data-tab="registros">Registros</button>
        <button class="tab-btn ${state.activeTab==='controle'?'active':''}" data-tab="controle">Controle de compensações${compRowsAll.length ? ' (' + compRowsAll.length + ')' : ''}</button>
        <button class="tab-btn ${state.activeTab==='semorigem'?'active':''}" data-tab="semorigem">Origem não importada${semOrigem.length ? ' (' + semOrigem.length + ')' : ''}</button>
        <button class="tab-btn ${state.activeTab==='lancamentos'?'active':''}" data-tab="lancamentos">Lançamentos contábeis${lancRows.length ? ' (' + lancRows.length + ')' : ''}</button>
        <button class="tab-btn ${state.activeTab==='controlecredito'?'active':''}" data-tab="controlecredito">Controle de crédito${state.creditoEntries.length ? ' (' + state.creditoEntries.length + ')' : ''}</button>
      </div>

      ${state.activeTab === 'registros' ? `
      <div class="stats">
        <div class="stamp" style="--accent-color:var(--brass)"><div class="n">${state.records.length}</div><div class="l">Total</div></div>
      </div>

      <div class="filters">
        <input type="text" id="fq" placeholder="Buscar nº PER/DCOMP" value="${esc(state.filters.q)}" />
        <select id="fcredito"><option value="">Todos os créditos</option>${creditoOpts.map(o=>`<option ${o===state.filters.credito?'selected':''}>${esc(o)}</option>`).join('')}</select>
        <select id="fdoc"><option value="">Todos os documentos</option>${docOpts.map(o=>`<option ${o===state.filters.documento?'selected':''}>${esc(o)}</option>`).join('')}</select>
        <select id="fsituacao"><option value="">Todas as situações</option>${situacaoOpts.map(o=>`<option ${o===state.filters.situacao?'selected':''}>${esc(o)}</option>`).join('')}</select>
        <select id="fnatureza"><option value="">Crédito e compensação</option>${naturezaOpts.map(k=>`<option value="${k}" ${k===state.filters.natureza?'selected':''}>${DOCTYPE_LABELS[k]}</option>`).join('')}</select>
        <input type="text" id="ffrom" class="date-filter-input" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(state.filters.from)}" title="De" />
        <input type="text" id="fto" class="date-filter-input" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(state.filters.to)}" title="Até" />
        <button class="clear" id="fclear">Limpar filtros</button>
        <span class="result-count">${filtered.length} de ${state.records.length}</span>
      </div>

      <div class="table-wrap">
        <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Nº PER/DCOMP</th><th>Transmissão</th><th>Tipo de crédito</th><th>Tipo de documento</th><th>Natureza</th><th>Situação</th><th style="text-align:right">Valor utilizado</th>
          </tr></thead>
          <tbody>
          ${filtered.length ? filtered.map(r => {
            const cat = statusCategory(r.situacao);
            const varName = STATUS_COLORS[cat];
            const pdf = state.pdfData[r.numero];
            const valor = pdf ? (pdf.totalCreditoUtilizado ?? pdf.totalDebitos) : null;
            const dtype = classifyDocType(pdf);
            return `<tr class="${pdf?'has-pdf':''}" ${pdf?`data-open="${esc(r.numero)}"`:''}>
              <td class="num">${pdf?'<span class="pdf-dot" title="PDF importado"></span>':''}${esc(r.numero)}</td>
              <td class="date">${esc(r.dataDisplay||'—')}</td>
              <td>${esc(r.tipoCredito)}</td>
              <td>${esc(r.tipoDocumento)}</td>
              <td>${dtype ? `<span class="badge" style="color:var(${DOCTYPE_COLORS[dtype]});border-color:var(${DOCTYPE_COLORS[dtype]});background:color-mix(in srgb, var(${DOCTYPE_COLORS[dtype]}) 14%, transparent);">${DOCTYPE_LABELS[dtype]}</span>` : '<span style="color:var(--paper-dim)">—</span>'}</td>
              <td><span class="badge" style="color:var(${varName});border-color:var(${varName});background:color-mix(in srgb, var(${varName}) 14%, transparent);">${esc(r.situacao)}</span></td>
              <td class="val">${valor!=null ? fmtBRL(valor) : '—'}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="7"><div class="empty-table">${state.records.length ? 'Nenhum registro corresponde aos filtros.' : 'Nenhum registro importado ainda. Use "Importar PDF(s)" acima.'}</div></td></tr>`}
          </tbody>
        </table>
        </div>
      </div>
      ` : state.activeTab === 'controle' ? `
      ${state.compReportMsg ? `<div class="upload-msg ${state.compReportMsg.kind}" style="margin-bottom:14px;max-width:none;">${esc(state.compReportMsg.text)}</div>` : ''}
      <div class="filters">
        <input type="text" id="fcorigem" placeholder="Buscar nº PER/DCOMP (origem ou compensação)" value="${esc(state.compFilters.busca)}" />
        <input type="text" id="fcompFrom" class="date-filter-input" inputmode="numeric" placeholder="mm/aaaa" maxlength="7" value="${esc(state.compFilters.from)}" title="Competência de (mês/ano da data da compensação)" />
        <input type="text" id="fcompTo" class="date-filter-input" inputmode="numeric" placeholder="mm/aaaa" maxlength="7" value="${esc(state.compFilters.to)}" title="Competência até (mês/ano da data da compensação)" />
        <button class="clear" id="fcompClear">Limpar filtros</button>
        <span class="result-count">${compRows.length} de ${compRowsAll.length} compensaç${compRowsAll.length===1?'ão':'ões'}</span>
        <button class="upload-btn secondary" id="compReportBtn" ${compRows.length ? '' : 'disabled'}>⭱ Gerar relatório PDF</button>
      </div>

      <div class="table-wrap">
        <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Nº PER/DCOMP inicial</th><th>PERDCOMP</th><th style="text-align:right">Créd. utilizado no doc.</th><th style="text-align:right">Crédito Selic</th><th>Data da compensação</th>
            <th style="text-align:right">Principal</th><th style="text-align:right">Multa</th><th style="text-align:right">Juros</th><th style="text-align:right">Total</th><th>Descrição da compensação</th>
          </tr></thead>
          <tbody>
          ${compRowsGrouped.length ? compRowsGrouped.map(r => `
            <tr${r.isGroupBoundary ? ' style="border-top:2px solid var(--line);"' : ''}>
              ${r.isFirst ? `
              <td class="num" style="cursor:pointer;vertical-align:top;" data-open-root="${esc(r.origem)}" rowspan="${r.rowspan}">${esc(r.origem)}</td>
              <td class="num" style="cursor:pointer;vertical-align:top;" data-open="${esc(r.perdcomp)}" rowspan="${r.rowspan}">${esc(r.perdcomp)}</td>
              <td class="val" style="vertical-align:top;" rowspan="${r.rowspan}">${fmtBRL(r.totalCreditoUtilizado)}</td>
              <td class="val" style="vertical-align:top;" rowspan="${r.rowspan}">${fmtBRL(r.creditoSelic)}</td>
              <td class="date" style="vertical-align:top;" rowspan="${r.rowspan}">${esc(r.dataCompensacao)}</td>` : ''}
              <td class="val">${fmtBRL(r.principal)}</td>
              <td class="val">${fmtBRL(r.multa)}</td>
              <td class="val">${fmtBRL(r.juros)}</td>
              <td class="val" style="color:var(--brass);font-weight:600;">${fmtBRL(r.total)}</td>
              <td>${esc(r.descricao)}</td>
            </tr>`).join('') : `<tr><td colspan="10"><div class="empty-table">${compRowsAll.length ? 'Nenhuma compensação corresponde ao filtro.' : 'Nenhum débito compensado encontrado nos PDFs importados ainda.'}</div></td></tr>`}
          </tbody>
          ${compRows.length ? `<tfoot><tr style="border-top:1px solid var(--line);">
            <td colspan="2" style="padding:11px 14px;color:var(--paper-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Total${state.compFilters.busca?' desta busca':''}</td>
            <td class="val" style="padding:11px 14px;">${fmtBRL(compTotals.creditoUtilizado)}</td>
            <td class="val" style="padding:11px 14px;">${fmtBRL(compTotals.creditoSelic)}</td>
            <td></td>
            <td class="val" style="padding:11px 14px;">${fmtBRL(compTotals.principal)}</td>
            <td class="val" style="padding:11px 14px;">${fmtBRL(compTotals.multa)}</td>
            <td class="val" style="padding:11px 14px;">${fmtBRL(compTotals.juros)}</td>
            <td class="val" style="padding:11px 14px;color:var(--brass);font-weight:600;">${fmtBRL(compTotals.total)}</td>
            <td></td>
          </tr></tfoot>` : ''}
        </table>
        </div>
      </div>
      ` : state.activeTab === 'semorigem' ? `
      <div class="upload-msg" style="margin-bottom:14px;max-width:none;">PER/DCOMP de Compensação cujo PDF do PER/DCOMP de Crédito que os originou (o "Nº do PER/DCOMP Inicial") ainda não foi importado. Importe o PDF de origem pra completar o cálculo do saldo dessas origens.</div>
      <div class="table-wrap">
        <div class="table-scroll">
        <table>
          <thead><tr>
            <th>PERDCOMP</th><th>Nº PER/DCOMP inicial (não localizado)</th><th>Transmissão</th><th>Tipo de crédito</th><th style="text-align:right">Créd. utilizado no doc.</th>
          </tr></thead>
          <tbody>
          ${semOrigem.length ? semOrigem.map(p => `
            <tr class="has-pdf" data-open="${esc(p.numero)}">
              <td class="num"><span class="pdf-dot" title="PDF importado"></span>${esc(p.numero)}</td>
              <td class="num" style="color:var(--andamento);">${esc(p.perdcompInicial)}</td>
              <td class="date">${esc(p.dataTransmissao||'—')}</td>
              <td>${esc(p.tipoCredito||'—')}</td>
              <td class="val">${fmtBRL(p.totalCreditoUtilizado)}</td>
            </tr>`).join('') : `<tr><td colspan="5"><div class="empty-table">Nenhuma pendência — todo PER/DCOMP de compensação importado tem a origem localizada.</div></td></tr>`}
          </tbody>
        </table>
        </div>
      </div>
      ` : state.activeTab === 'lancamentos' ? `
      <div class="upload-msg" style="margin-bottom:14px;max-width:none;">Lançamentos contábeis calculados a partir dos PER/DCOMP de compensação importados — um lançamento por conta contábil agrupada em cada documento, com as mesmas colunas do arquivo exportado. Se alguma conta estiver errada, escolha outra no lugar; Complemento Histórico, Cód. Histórico, Inicia Lote, Matriz/Filial e os Centros de Custo também podem ser editados direto na tabela.${!(client && client.codMatrizFilial) ? ' <span style="color:var(--andamento);cursor:pointer;" id="matrizMissingLink">⚠ Código Matriz/Filial não cadastrado para este cliente — configure no cadastro antes de exportar. Cadastrar agora</span>' : ''}</div>
      ${state.lancMsg ? `<div class="upload-msg ${state.lancMsg.kind}" style="margin-bottom:14px;max-width:none;">${esc(state.lancMsg.text)}</div>` : ''}

      <div class="filters">
        <input type="text" id="lancBusca" placeholder="Buscar nº PER/DCOMP" value="${esc(state.lancFilters.busca)}" />
        <span style="color:var(--paper-dim);font-size:12px;">Data de criação do PER/DCOMP:</span>
        <input type="text" id="lancFrom" class="date-filter-input" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(state.lancFilters.from)}" title="De" />
        <input type="text" id="lancTo" class="date-filter-input" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(state.lancFilters.to)}" title="Até" />
        <button class="clear" id="lancFilterClear">Limpar filtro</button>
        <span class="result-count">${lancRowsFiltered.length} de ${lancRows.length} lançamento(s)${lancSemDebito ? ' · ' + lancSemDebito + ' sem conta de débito' : ''}${lancSemCredito ? ' · ' + lancSemCredito + ' sem conta de crédito' : ''}${lancNaoMapeados.length ? ' · ' + lancNaoMapeados.length + ' débito(s) sem conta mapeada' : ''}</span>
        <button class="upload-btn" id="downloadTxtBtn" ${lancRowsFiltered.length ? '' : 'disabled'}>⭳ Baixar .txt para Domínio</button>
      </div>

      <div class="table-wrap">
        <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Data</th><th>Cód. Conta Débito</th><th>Cód. Conta Crédito</th><th style="text-align:right">Valor</th><th>Cód. Histórico</th><th>Complemento Histórico</th><th>Inicia Lote</th><th>Matriz/Filial</th><th>C. Custo Débito</th><th>C. Custo Crédito</th><th>Nº PER/DCOMP</th>
          </tr></thead>
          <tbody>
          ${lancRowsFiltered.length ? lancRowsFiltered.map(r => `
            <tr>
              <td class="date" data-open="${esc(r.perdcomp)}" style="cursor:pointer;">${esc(r.data||'—')}</td>
              <td>
                ${r.lado === 'debito' ? `
                <select class="lanc-conta-select" data-role="debito" data-key="${esc(r.groupKey)}" id="${domSafeId('lancDeb', r.groupKey)}">
                  ${DEBITO_CONTA_OPTIONS.map(([code,nome]) => `<option value="${code}" ${(code===r.contaDebito && !r.debitoCustom)?'selected':''}>${code} — ${esc(nome)}</option>`).join('')}
                  <option value="__custom__" ${r.debitoCustom?'selected':''}>✎ Outra conta (digitar)…</option>
                </select>
                ${r.debitoCustom ? `
                <div class="lanc-custom-conta">
                  <input type="text" class="lanc-custom-input" data-role="debito" data-field="conta" data-key="${esc(r.groupKey)}" id="${domSafeId('lancDebCod', r.groupKey)}" placeholder="Código" maxlength="20" value="${esc(r.contaDebito)}" />
                  <input type="text" class="lanc-custom-input" data-role="debito" data-field="nome" data-key="${esc(r.groupKey)}" id="${domSafeId('lancDebNome', r.groupKey)}" placeholder="Nome da conta" maxlength="80" value="${esc(r.contaDebitoNome)}" />
                </div>` : ''}
                ${!r.contaDebito ? '<span class="badge" style="margin-left:4px;color:var(--neg);border-color:var(--neg);background:transparent;font-size:9.5px;" title="Informe o código da conta de débito">⚠ não configurada</span>' : (!r.debitoConfirmado ? '<span class="badge" style="margin-left:4px;color:var(--andamento);border-color:var(--andamento);background:transparent;font-size:9.5px;" title="Mapeamento sugerido pelo nome do tributo, ainda não confirmado">sugestão</span>' : '')}
                ` : `
                <input type="text" class="form-input lanc-field-input" data-field="debitoExtra" data-key="${esc(r.groupKey)}" id="${domSafeId('lancDebExtra', r.groupKey)}" value="${esc(r.contaDebito)}" placeholder="—" title="Esta linha é de crédito; a conta de débito fica em branco por padrão. Preencha aqui só se precisar dela também nesta linha." style="width:90px;" maxlength="20" />
                `}
              </td>
              <td>
                ${r.lado === 'credito' ? `
                <select class="lanc-conta-select" data-role="credito" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCred', r.groupKey)}">
                  <option value="">— selecione —</option>
                  ${CREDITO_CONTA_OPTIONS.map(([code,nome]) => `<option value="${code}" ${(code===r.contaCredito && !r.creditoCustom)?'selected':''}>${code} — ${esc(nome)}</option>`).join('')}
                  <option value="__custom__" ${r.creditoCustom?'selected':''}>✎ Outra conta (digitar)…</option>
                </select>
                ${r.creditoCustom ? `
                <div class="lanc-custom-conta">
                  <input type="text" class="lanc-custom-input" data-role="credito" data-field="conta" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCredCod', r.groupKey)}" placeholder="Código" maxlength="20" value="${esc(r.contaCredito)}" />
                  <input type="text" class="lanc-custom-input" data-role="credito" data-field="nome" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCredNome', r.groupKey)}" placeholder="Nome da conta" maxlength="80" value="${esc(r.contaCreditoNome)}" />
                </div>` : ''}
                ${!r.contaCredito ? '<span class="badge" style="margin-left:4px;color:var(--neg);border-color:var(--neg);background:transparent;font-size:9.5px;" title="Ainda não sei qual conta de crédito usar para esse tipo de crédito">⚠ não configurada</span>' : (!r.creditoConfirmado ? '<span class="badge" style="margin-left:4px;color:var(--andamento);border-color:var(--andamento);background:transparent;font-size:9.5px;" title="Mapeamento sugerido pelo nome do tributo, ainda não confirmado">sugestão</span>' : '')}
                ` : `
                <input type="text" class="form-input lanc-field-input" data-field="creditoExtra" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCredExtra', r.groupKey)}" value="${esc(r.contaCredito)}" placeholder="—" title="Esta linha é de débito; a conta de crédito fica em branco por padrão. Preencha aqui só se precisar dela também nesta linha." style="width:90px;" maxlength="20" />
                `}
              </td>
              <td class="val" style="color:var(--brass);font-weight:600;">${fmtBRL(r.valor)}</td>
              <td><input type="text" class="form-input lanc-field-input" data-field="codHistorico" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCodHist', r.groupKey)}" value="${esc(r.codHistorico)}" style="width:64px;" maxlength="10" /></td>
              <td><input type="text" class="form-input lanc-complemento-input" data-key="${esc(r.groupKey)}" id="${domSafeId('lancComp', r.groupKey)}" value="${esc(r.complemento)}" style="width:100%;min-width:220px;" /></td>
              <td><input type="text" class="form-input lanc-field-input" data-field="iniciaLote" data-key="${esc(r.groupKey)}" id="${domSafeId('lancIniciaLote', r.groupKey)}" value="${esc(r.iniciaLote)}" style="width:64px;" maxlength="5" /></td>
              <td><input type="text" class="form-input lanc-field-input" data-field="matrizFilial" data-key="${esc(r.groupKey)}" id="${domSafeId('lancMatrizFilial', r.groupKey)}" value="${esc(r.matrizFilial)}" style="width:74px;" maxlength="6" /></td>
              <td><input type="text" class="form-input lanc-field-input" data-field="centroCustoDebito" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCcDeb', r.groupKey)}" value="${esc(r.centroCustoDebito)}" style="width:90px;" maxlength="20" /></td>
              <td><input type="text" class="form-input lanc-field-input" data-field="centroCustoCredito" data-key="${esc(r.groupKey)}" id="${domSafeId('lancCcCred', r.groupKey)}" value="${esc(r.centroCustoCredito)}" style="width:90px;" maxlength="20" /></td>
              <td class="num" data-open="${esc(r.perdcomp)}" style="cursor:pointer;">${esc(r.perdcomp)}</td>
            </tr>`).join('') : `<tr><td colspan="11"><div class="empty-table">${lancRows.length ? 'Nenhum lançamento no período selecionado.' : 'Nenhum lançamento gerado ainda — importe PDFs de compensação para este cliente.'}</div></td></tr>`}
          </tbody>
          ${lancRowsFiltered.length ? `<tfoot><tr style="border-top:1px solid var(--line);">
            <td colspan="3" style="padding:11px 14px;color:var(--paper-dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Total</td>
            <td class="val" style="padding:11px 14px;color:var(--brass);font-weight:600;">${fmtBRL(lancRowsFiltered.reduce((s,r)=>s+(r.valor||0),0))}</td>
            <td colspan="7"></td>
          </tr></tfoot>` : ''}
        </table>
        </div>
      </div>

      ${lancNaoMapeados.length ? `
      <div class="upload-msg err" style="margin-top:14px;max-width:none;">
        ${lancNaoMapeados.length} débito(s) não entraram em nenhum lançamento porque ainda não sei a conta contábil certa. Me diga qual conta usar para cada um destes:
        <ul style="margin:8px 0 0 18px;padding:0;">
          ${Object.values(lancNaoMapeados.reduce((acc,d) => {
            const key = d.grupoTributo || d.descricao || '—';
            (acc[key] = acc[key] || { key, total:0, count:0 }).total += (d.total||0);
            acc[key].count++;
            return acc;
          }, {})).map(g => `<li>${esc(g.key)} — ${g.count} débito(s), ${fmtBRL(g.total)}</li>`).join('')}
        </ul>
      </div>` : ''}
      ` : `
      <div class="upload-msg" style="margin-bottom:14px;max-width:none;">Lançamentos de crédito preenchidos à mão — Tipo de crédito e Período do crédito, do jeito que estiverem aqui, são comparados com as origens já identificadas nos PER/DCOMP importados. Se baterem os dois, a Situação fica "Crédito indisponível" (esse crédito já apareceu num PER/DCOMP importado); senão, "Crédito disponível".</div>
      <div class="filters">
        <span class="result-count">${creditoEntriesView.length} lançamento(s)</span>
        <button class="upload-btn" id="addCreditoBtn">+ Adicionar crédito</button>
      </div>

      <div class="table-wrap credito-manual">
        <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Tipo de crédito</th><th>Período do crédito</th><th>Periodicidade</th><th style="text-align:right">Valor original</th><th>Situação</th><th>Observação</th><th></th>
          </tr></thead>
          <tbody>
          ${creditoEntriesView.length ? creditoEntriesView.map(c => `
            <tr>
              <td>${esc(c.tipoCredito||'—')}</td>
              <td>${esc(c.periodoCredito||'—')}</td>
              <td style="color:var(--paper-dim);">${esc(creditoPeriodicidade(c.tipoCredito) || '—')}</td>
              <td class="val">${c.valorOriginal!=null ? fmtBRL(c.valorOriginal) : '—'}</td>
              <td><span class="badge" style="color:var(${c.situacao==='indisponivel'?'--neg':'--pos'});border-color:var(${c.situacao==='indisponivel'?'--neg':'--pos'});background:color-mix(in srgb, var(${c.situacao==='indisponivel'?'--neg':'--pos'}) 14%, transparent);">${c.situacao==='indisponivel'?'CRÉDITO INDISPONÍVEL':'CRÉDITO DISPONÍVEL'}</span></td>
              <td>${esc(c.observacao||'—')}</td>
              <td style="white-space:nowrap;text-align:right;">
                <button class="edit" data-credito-edit="${esc(c.id)}" title="Editar" style="opacity:.6;background:none;border:none;color:var(--paper-dim);font-size:12.5px;cursor:pointer;padding:0 4px;">✎</button>
                <button class="del" data-credito-del="${esc(c.id)}" title="Remover" style="opacity:.6;background:none;border:none;color:var(--neg);font-size:14px;cursor:pointer;padding:0 4px;">✕</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="7"><div class="empty-table">Nenhum lançamento de crédito cadastrado ainda. Use "+ Adicionar crédito" acima.</div></td></tr>`}
          </tbody>
        </table>
        </div>
      </div>
      `}
    `;

    document.getElementById('uploadBtn').addEventListener('click', () => {
      state.activeTab = 'lancamentos';
      renderMain();
    });
    document.getElementById('uploadPdfBtn').addEventListener('click', () => document.getElementById('pdfInput').click());
    document.getElementById('cnpjMissingLink')?.addEventListener('click', () => openClientModal(client.slug));
    document.getElementById('matrizMissingLink')?.addEventListener('click', () => openClientModal(client.slug, { focus:'matriz' }));
    document.getElementById('downloadTxtBtn')?.addEventListener('click', () => {
      if (!(client && client.codMatrizFilial)){
        openClientModal(client.slug, { notice: 'Informe o Código Matriz/Filial antes de gerar o arquivo para o Domínio.', focus: 'matriz' });
        return;
      }
      exportLancamentosTxt(lancRowsFiltered, client);
    });
    document.getElementById('lancBusca')?.addEventListener('input', e => { state.lancFilters.busca = e.target.value; renderMain(); });
    document.getElementById('lancFrom')?.addEventListener('input', e => { e.target.value = formatDateBr(e.target.value); state.lancFilters.from = e.target.value; renderMain(); });
    document.getElementById('lancTo')?.addEventListener('input', e => { e.target.value = formatDateBr(e.target.value); state.lancFilters.to = e.target.value; renderMain(); });
    document.getElementById('lancFilterClear')?.addEventListener('click', () => { state.lancFilters = { from:'', to:'', busca:'' }; renderMain(); });
    document.querySelectorAll('.lanc-conta-select[data-role="debito"]').forEach(el => {
      el.addEventListener('change', async (e) => {
        const key = el.dataset.key;
        // "Outra conta (digitar)" — plano de contas do cliente é diferente e nenhuma conta
        // da lista serve: guarda um objeto {conta, nome} em branco pra abrir os campos de
        // digitação livre (ver renderização da célula e o handler de .lanc-custom-input).
        state.lancOverrides.debito[key] = (e.target.value === '__custom__') ? { conta:'', nome:'' } : e.target.value;
        await saveLancOverrides();
        renderMain();
        if (e.target.value === '__custom__') document.getElementById(domSafeId('lancDebCod', key))?.focus();
      });
    });
    document.querySelectorAll('.lanc-conta-select[data-role="credito"]').forEach(el => {
      el.addEventListener('change', async (e) => {
        const key = el.dataset.key;
        if (e.target.value === '__custom__') state.lancOverrides.credito[key] = { conta:'', nome:'' };
        else if (e.target.value) state.lancOverrides.credito[key] = e.target.value;
        else delete state.lancOverrides.credito[key];
        await saveLancOverrides();
        renderMain();
        if (e.target.value === '__custom__') document.getElementById(domSafeId('lancCredCod', key))?.focus();
      });
    });
    document.querySelectorAll('.lanc-custom-input').forEach(el => {
      // Mesmo padrão do Complemento Histórico logo abaixo: só grava no armazenamento
      // compartilhado quando termina de editar (blur/Enter/troca de campo), pra não gravar
      // a cada tecla digitada.
      el.addEventListener('input', e => {
        const key = el.dataset.key, role = el.dataset.role, field = el.dataset.field;
        const bucket = role === 'debito' ? state.lancOverrides.debito : state.lancOverrides.credito;
        if (!bucket[key] || typeof bucket[key] !== 'object') bucket[key] = { conta:'', nome:'' };
        bucket[key][field] = e.target.value;
      });
      el.addEventListener('change', async () => { await saveLancOverrides(); renderMain(); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    });
    document.querySelectorAll('.lanc-complemento-input').forEach(el => {
      // Só grava no armazenamento compartilhado quando o usuário termina de editar (blur/Enter)
      // — evita gravação a cada tecla digitada. O valor em si já fica correto na tela porque
      // é o próprio campo que o usuário está digitando.
      el.addEventListener('input', e => { state.lancOverrides.complemento[el.dataset.key] = e.target.value; });
      el.addEventListener('change', async () => { await saveLancOverrides(); renderMain(); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    });
    document.querySelectorAll('.lanc-field-input').forEach(el => {
      // Cód. Histórico, Inicia Lote, Matriz/Filial e os dois Centros de Custo — mesmo padrão
      // do Complemento Histórico acima (só grava no banco compartilhado ao terminar de editar).
      // data-field diz em qual balde de state.lancOverrides a correção entra.
      el.addEventListener('input', e => {
        const field = el.dataset.field, key = el.dataset.key;
        if (!state.lancOverrides[field]) state.lancOverrides[field] = {};
        state.lancOverrides[field][key] = e.target.value;
      });
      el.addEventListener('change', async () => { await saveLancOverrides(); renderMain(); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    });
    document.querySelectorAll('[data-open]').forEach(el => {
      el.addEventListener('click', () => { state.modalNumero = el.dataset.open; state.modalRoot = null; state.modalClient = null; state.modalImportFails = null; state.modalCredito = null; state.modalConfirm = null; renderModal(); });
    });
    document.querySelectorAll('[data-open-root]').forEach(el => {
      el.addEventListener('click', () => { state.modalRoot = el.dataset.openRoot; state.modalNumero = null; state.modalClient = null; state.modalImportFails = null; state.modalCredito = null; state.modalConfirm = null; renderModal(); });
    });
    document.querySelectorAll('.tab-btn').forEach(el => {
      el.addEventListener('click', () => { state.activeTab = el.dataset.tab; renderMain(); });
    });
    document.getElementById('fq')?.addEventListener('input', e => { state.filters.q = e.target.value; renderMain(); });
    document.getElementById('fcredito')?.addEventListener('change', e => { state.filters.credito = e.target.value; renderMain(); });
    document.getElementById('fdoc')?.addEventListener('change', e => { state.filters.documento = e.target.value; renderMain(); });
    document.getElementById('fsituacao')?.addEventListener('change', e => { state.filters.situacao = e.target.value; renderMain(); });
    document.getElementById('fnatureza')?.addEventListener('change', e => { state.filters.natureza = e.target.value; renderMain(); });
    document.getElementById('ffrom')?.addEventListener('input', e => { e.target.value = formatDateBr(e.target.value); state.filters.from = e.target.value; renderMain(); });
    document.getElementById('fto')?.addEventListener('input', e => { e.target.value = formatDateBr(e.target.value); state.filters.to = e.target.value; renderMain(); });
    document.getElementById('fclear')?.addEventListener('click', () => { state.filters = { q:'', credito:'', documento:'', situacao:'', natureza:'', from:'', to:'' }; renderMain(); });
    document.getElementById('fcorigem')?.addEventListener('input', e => { state.compFilters.busca = e.target.value; renderMain(); });
    document.getElementById('fcompFrom')?.addEventListener('input', e => { e.target.value = formatMonthYear(e.target.value); state.compFilters.from = e.target.value; renderMain(); });
    document.getElementById('fcompTo')?.addEventListener('input', e => { e.target.value = formatMonthYear(e.target.value); state.compFilters.to = e.target.value; renderMain(); });
    document.getElementById('fcompClear')?.addEventListener('click', () => { state.compFilters = { busca:'', from:'', to:'' }; renderMain(); });
    document.getElementById('compReportBtn')?.addEventListener('click', () => {
      generateCompensacoesReport(compRowsGrouped, compTotals, client, state.compFilters);
    });
    document.getElementById('addCreditoBtn')?.addEventListener('click', () => openCreditoModal(null));
    document.querySelectorAll('[data-credito-edit]').forEach(el => {
      el.addEventListener('click', () => openCreditoModal(el.dataset.creditoEdit));
    });
    document.querySelectorAll('[data-credito-del]').forEach(el => {
      el.addEventListener('click', () => deleteCreditoEntryConfirm(el.dataset.creditoDel));
    });
  }

  document.getElementById('addClientBtn').addEventListener('click', () => openClientModal(null));
  document.getElementById('pdfInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) handlePdfFiles(files);
    e.target.value = '';
  });
  function renderModal(){
    const box = document.getElementById('modalArea');
    if (state.modalConfirm){ renderConfirmModal(box); return; }
    if (state.modalClient){ renderClientModal(box); return; }
    if (state.modalImportFails){ renderImportFailModal(box); return; }
    if (state.modalCredito){ renderCreditoModal(box); return; }
    if (state.modalRoot){ renderRootModal(box); return; }
    if (!state.modalNumero){ box.innerHTML = ''; return; }
    const p = state.pdfData[state.modalNumero];
    if (!p){ state.modalNumero = null; box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <button class="modal-close" id="modalCloseBtn">✕</button>
          <h3>${esc(p.nomeEmpresarial || 'Detalhe do PER/DCOMP')}</h3>
          <span class="num">${esc(p.numero)} ${(() => { const dtype = classifyDocType(p); return dtype ? `<span class="badge" style="margin-left:4px;color:var(${DOCTYPE_COLORS[dtype]});border-color:var(${DOCTYPE_COLORS[dtype]});background:color-mix(in srgb, var(${DOCTYPE_COLORS[dtype]}) 14%, transparent);">${DOCTYPE_LABELS[dtype]}</span>` : ''; })()}</span>

          <div class="modal-section">
            <div class="st">Documento</div>
            <div class="modal-grid">
              <span class="k">CNPJ</span><span class="v">${esc(p.cnpj||'—')}</span>
              <span class="k">Tipo de documento</span><span class="v">${esc(p.tipoDocumento||'—')}</span>
              <span class="k">Tipo de crédito</span><span class="v">${esc(p.tipoCredito||'—')}</span>
              <span class="k">Período do crédito</span><span class="v">${esc(p.periodoCredito||'—')}</span>
              <span class="k">Data de transmissão</span><span class="v">${esc(p.dataTransmissao||'—')}</span>
            </div>
          </div>

          <div class="modal-section">
            <div class="st">Valores do crédito</div>
            <div class="modal-grid">
              <span class="k">Valor original do crédito</span><span class="v">${fmtBRL(p.valorCreditoInicial)}</span>
              <span class="k">Crédito na data de entrega</span><span class="v">${fmtBRL(p.creditoEntrega)}</span>
              <span class="k">Crédito atualizado</span><span class="v">${fmtBRL(p.creditoAtualizado)}</span>
              <span class="k">Total de débitos do documento</span><span class="v">${fmtBRL(p.totalDebitos)}</span>
              <span class="k">Total do crédito utilizado</span><span class="v big">${fmtBRL(p.totalCreditoUtilizado)}</span>
              <span class="k">Saldo do crédito original</span><span class="v big">${fmtBRL(p.saldoCreditoOriginal)}</span>
            </div>
          </div>

          ${p.perdcompInicial ? `
          <div class="modal-section">
            <div class="st">Origem do crédito</div>
            <button class="modal-link" id="modalGoInicial">↳ Ver origem completa: ${esc(p.perdcompInicial)}</button>
          </div>` : ''}
        </div>
      </div>`;
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay'){ state.modalNumero = null; renderModal(); }
    });
    document.getElementById('modalCloseBtn').addEventListener('click', () => { state.modalNumero = null; renderModal(); });
    const goBtn = document.getElementById('modalGoInicial');
    if (goBtn) goBtn.addEventListener('click', () => {
      state.modalNumero = null;
      state.modalRoot = p.perdcompInicial;
      renderModal();
    });
  }

  function renderClientModal(box){
    const editing = state.modalClient.slug ? state.clients.find(c => c.slug === state.modalClient.slug) : null;
    const nameVal = editing ? editing.name : '';
    const cnpjVal = editing ? formatCnpj(editing.cnpj || '') : '';
    const matrizVal = editing ? (editing.codMatrizFilial || '') : '';
    box.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal" style="max-width:420px;">
          <button class="modal-close" id="modalCloseBtn">✕</button>
          <h3>${editing ? 'Editar cliente' : 'Cadastrar cliente'}</h3>
          <span class="num">${editing ? 'Alterando o cadastro de ' + esc(editing.name) : 'O CNPJ é usado para conferir cada PER/DCOMP importado.'}</span>

          <div class="form-field">
            <label class="form-label">Nome da empresa</label>
            <input type="text" id="clientNameInput" class="form-input" maxlength="120" value="${esc(nameVal)}" placeholder="Razão social ou nome fantasia" />
          </div>
          <div class="form-field">
            <label class="form-label">CNPJ</label>
            <input type="text" id="clientCnpjInput" class="form-input" maxlength="18" value="${esc(cnpjVal)}" placeholder="00.000.000/0000-00" inputmode="numeric" />
          </div>
          <div class="form-field">
            <label class="form-label">Código Matriz/Filial (Domínio)</label>
            <input type="text" id="clientMatrizInput" class="form-input" maxlength="6" value="${esc(matrizVal)}" placeholder="Ex.: 7" inputmode="numeric" />
          </div>
          <div class="form-error" id="clientFormError">${state.modalClient.notice ? esc(state.modalClient.notice) : ''}</div>
          <div class="form-actions">
            <button class="form-cancel" id="clientFormCancel">Cancelar</button>
            <button class="form-save" id="clientFormSave">${editing ? 'Salvar' : 'Cadastrar'}</button>
          </div>
        </div>
      </div>`;
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeClientModal();
    });
    document.getElementById('modalCloseBtn').addEventListener('click', closeClientModal);
    document.getElementById('clientFormCancel').addEventListener('click', closeClientModal);
    const nameInput = document.getElementById('clientNameInput');
    const cnpjInput = document.getElementById('clientCnpjInput');
    const matrizInput = document.getElementById('clientMatrizInput');
    cnpjInput.addEventListener('input', (e) => { e.target.value = formatCnpj(e.target.value); });
    matrizInput.addEventListener('input', (e) => { e.target.value = onlyDigits(e.target.value); });
    document.getElementById('clientFormSave').addEventListener('click', submitClientForm);
    [nameInput, cnpjInput, matrizInput].forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitClientForm(); }));
    (state.modalClient.focus === 'matriz' ? matrizInput : nameInput).focus();
  }

  function renderCreditoModal(box){
    const editing = state.modalCredito.id ? state.creditoEntries.find(c => c.id === state.modalCredito.id) : null;
    const tipoVal = editing ? editing.tipoCredito : '';
    const periodoVal = editing ? editing.periodoCredito : '';
    const valorVal = editing && editing.valorOriginal != null ? editing.valorOriginal.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 }) : '';
    const obsVal = editing ? (editing.observacao || '') : '';
    // Sugestões de "Tipo de crédito": a lista fixa dos tipos mais comuns + os tipos já
    // vistos nos PDFs importados deste cliente (sem duplicar) — texto livre, a lista é só
    // pra ajudar a digitar de forma consistente.
    const tipoSugestoes = [...new Set([...CREDITO_TIPO_SUGESTOES_FIXAS, ...distinctSorted(state.records, 'tipoCredito')])];
    box.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal" style="max-width:420px;">
          <button class="modal-close" id="modalCloseBtn">✕</button>
          <h3>${editing ? 'Editar crédito' : 'Adicionar crédito'}</h3>
          <span class="num">${editing ? 'Alterando o lançamento manual' : 'Situação é calculada automaticamente a partir das origens já importadas.'}</span>

          <div class="form-field">
            <label class="form-label">Tipo de crédito</label>
            <input type="text" id="creditoTipoInput" class="form-input" maxlength="160" list="creditoTipoList" value="${esc(tipoVal)}" placeholder="Ex.: Saldo Negativo de IRPJ" />
            <datalist id="creditoTipoList">${tipoSugestoes.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist>
          </div>
          <div class="form-field">
            <label class="form-label">Período do crédito</label>
            <div id="creditoPeriodoBody" data-modo="${creditoPeriodoModo(tipoVal)}">${creditoPeriodoBodyHtml(tipoVal, periodoVal)}</div>
            <div id="creditoPeriodicidadeHint" style="font-size:11.5px;color:var(--paper-dim);margin-top:6px;">${(() => { const p = creditoPeriodicidade(tipoVal); return p ? 'Periodicidade sugerida pra esse tipo: <b style="color:var(--paper)">' + esc(p) + '</b>' : 'Periodicidade sugerida pra esse tipo: informe o Tipo de crédito acima'; })()}</div>
          </div>
          <div class="form-field">
            <label class="form-label">Valor original (R$)</label>
            <input type="text" id="creditoValorInput" class="form-input" inputmode="numeric" value="${esc(valorVal)}" placeholder="0,00" />
          </div>
          <div class="form-field">
            <label class="form-label">Observação</label>
            <input type="text" id="creditoObsInput" class="form-input" maxlength="300" value="${esc(obsVal)}" placeholder="Opcional" />
          </div>
          <div class="form-error" id="creditoFormError">${state.modalCredito.notice ? esc(state.modalCredito.notice) : ''}</div>
          <div class="form-actions">
            <button class="form-cancel" id="creditoFormCancel">Cancelar</button>
            <button class="form-save" id="creditoFormSave">${editing ? 'Salvar' : 'Adicionar'}</button>
          </div>
        </div>
      </div>`;
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeCreditoModal();
    });
    document.getElementById('modalCloseBtn').addEventListener('click', closeCreditoModal);
    document.getElementById('creditoFormCancel').addEventListener('click', closeCreditoModal);
    const tipoInput = document.getElementById('creditoTipoInput');
    const valorInput = document.getElementById('creditoValorInput');
    const obsInput = document.getElementById('creditoObsInput');
    const periodicidadeHint = document.getElementById('creditoPeriodicidadeHint');
    wireCreditoPeriodoBody(tipoInput);
    tipoInput.addEventListener('input', (e) => {
      const p = creditoPeriodicidade(e.target.value);
      periodicidadeHint.innerHTML = p ? 'Periodicidade sugerida pra esse tipo: <b style="color:var(--paper)">' + esc(p) + '</b>' : 'Periodicidade sugerida pra esse tipo: informe o Tipo de crédito acima';
      // Reconstrói o campo de Período só quando o modo muda (texto livre, Mensal,
      // Trimestral, DARF ou o seletor Trimestre/Ano), preservando o que já foi
      // digitado/escolhido até aqui.
      const bodyEl = document.getElementById('creditoPeriodoBody');
      const novoModo = creditoPeriodoModo(e.target.value);
      if (novoModo !== bodyEl.dataset.modo){
        const currentVal = document.getElementById('creditoPeriodoInput').value;
        bodyEl.dataset.modo = novoModo;
        bodyEl.innerHTML = creditoPeriodoBodyHtml(e.target.value, currentVal);
        wireCreditoPeriodoBody(tipoInput);
      } else if (novoModo === 'livre'){
        const pInput = document.getElementById('creditoPeriodoInput');
        if (pInput) pInput.placeholder = creditoPeriodoPlaceholder(e.target.value);
      }
    });
    valorInput.addEventListener('input', (e) => { e.target.value = formatCurrencyInput(e.target.value); });
    document.getElementById('creditoFormSave').addEventListener('click', submitCreditoForm);
    [tipoInput, valorInput, obsInput].forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreditoForm(); }));
    tipoInput.focus();
  }

  function renderConfirmModal(box){
    const { title, message, confirmLabel } = state.modalConfirm;
    box.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal" style="max-width:420px;">
          <button class="modal-close" id="modalCloseBtn">✕</button>
          <h3>${esc(title)}</h3>
          <div class="upload-msg" style="max-width:none;margin:10px 0 4px;">${esc(message)}</div>
          <div class="form-actions">
            <button class="form-cancel" id="confirmCancelBtn">Cancelar</button>
            <button class="form-save danger" id="confirmOkBtn">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeConfirmModal();
    });
    document.getElementById('modalCloseBtn').addEventListener('click', closeConfirmModal);
    document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirmModal);
    document.getElementById('confirmOkBtn').addEventListener('click', async () => {
      const action = state.modalConfirm && state.modalConfirm.onConfirm;
      state.modalConfirm = null;
      renderModal();
      if (action) await action();
    });
    document.getElementById('confirmOkBtn').focus();
  }

  function importFailReasonLabel(it){
    if (it.reason === 'cnpj') return 'CNPJ divergente — ' + (it.cnpj ? formatCnpj(it.cnpj) : 'não identificado');
    return 'Não parece ser um PER/DCOMP';
  }

  function renderImportFailModal(box){
    const { items, expected, contextLabel } = state.modalImportFails;
    const isPlanilha = contextLabel === 'planilha';
    const plural = items.length > 1;
    const hasCnpj = items.some(it => it.reason === 'cnpj');
    const hasEstrutura = items.some(it => it.reason === 'estrutura');

    let expl;
    if (hasCnpj && hasEstrutura){
      expl = `Alguns ${isPlanilha?'linhas':'arquivos'} não foram importados: ou não têm a estrutura de um PER/DCOMP da Receita Federal, ou trazem um CNPJ diferente do cadastrado para este cliente (<b>${esc(formatCnpj(expected))}</b>). Veja o motivo de cada um na tabela abaixo.`;
    } else if (hasEstrutura){
      expl = `${plural ? 'Esses arquivos não têm' : 'Esse arquivo não tem'} a estrutura de um PER/DCOMP da Receita Federal (cabeçalho "Receita Federal do Brasil", título "Pedido de Restituição, Ressarcimento ou Reembolso e Declaração de Compensação" e a seção "Dados Iniciais"), então ${plural?'não foram importados':'não foi importado'}. Confira se ${plural?'são realmente PDFs de PER/DCOMP':'é realmente um PDF de PER/DCOMP'}.`;
    } else {
      expl = `${plural ? 'Esses documentos trazem' : 'Esse documento traz'} um CNPJ diferente do CNPJ cadastrado para este cliente (<b>${esc(formatCnpj(expected))}</b>), então ${plural?'não foram importados':'não foi importado'}. Confira se ${isPlanilha ? (plural?'essas linhas são':'essa linha é') : (plural?'esses arquivos são':'esse arquivo é')} realmente dessa empresa — ou corrija o CNPJ cadastrado do cliente se ele estiver errado.`;
    }

    box.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal" style="max-width:min(760px,94vw);">
          <button class="modal-close" id="modalCloseBtn">✕</button>
          <h3>${items.length} ${isPlanilha ? (plural?'linhas não importadas':'linha não importada') : (plural?'PDFs não importados':'PDF não importado')}</h3>
          <span class="num">${hasCnpj && hasEstrutura ? 'Mais de um motivo de rejeição' : hasEstrutura ? 'Estrutura de PER/DCOMP não reconhecida' : (plural?'CNPJ divergem':'CNPJ diverge') + ' do cadastro deste cliente'}</span>

          <div class="upload-msg err" style="max-width:none;margin-bottom:16px;">${expl}</div>

          <div class="modal-section">
            <div class="st">${isPlanilha ? 'Linhas não importadas' : 'Arquivos não importados'}</div>
            <div class="table-wrap">
              <div class="table-scroll" style="max-height:36vh">
                <table>
                  <thead><tr><th>${isPlanilha ? 'Nº PER/DCOMP' : 'Arquivo'}</th><th>Motivo</th></tr></thead>
                  <tbody>
                  ${items.map(it => `<tr>
                    <td class="${isPlanilha ? 'num' : ''}">${esc(it.label)}</td>
                    <td>${esc(importFailReasonLabel(it))}</td>
                  </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeImportFailModal();
    });
    document.getElementById('modalCloseBtn').addEventListener('click', closeImportFailModal);
  }

  function renderRootModal(box){
    const roots = computeCreditRoots(state.pdfData);
    const r = roots.find(r => r.root === state.modalRoot);
    if (!r){ state.modalRoot = null; box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal" style="max-width:min(880px,94vw);">
          <button class="modal-close" id="modalCloseBtn">✕</button>
          <h3>Origem do crédito</h3>
          <span class="num">${esc(r.root)}</span>

          <div class="modal-section">
            <div class="modal-grid">
              <span class="k">Tipo de crédito</span><span class="v">${esc(r.tipoCredito||'—')}</span>
              <span class="k">Período do crédito</span><span class="v">${esc(r.periodoCredito||'—')}</span>
              <span class="k">PER/DCOMP de crédito (origem) importado</span><span class="v">${r.origemImportada ? 'Sim' : 'Não'}</span>
              <span class="k">Compensações vinculadas</span><span class="v">${r.qtdCompensacoes}</span>
              <span class="k">Valor original do crédito</span><span class="v big">${fmtBRL(r.valorOriginal)}</span>
              <span class="k">Saldo disponível hoje</span><span class="v big" style="color:var(--pos)">${fmtBRL(r.saldoAtual)}${r.saldoEstimado?' *':''}</span>
            </div>
            ${r.saldoEstimado ? `<div class="upload-msg" style="margin-top:6px;">* não encontrei o valor original do crédito em nenhum documento importado, então não deu pra calcular o saldo por subtração; usei o último "Saldo do Crédito Original" relatado, que pode não refletir a ordem real entre compensações com a mesma data.</div>` : ''}
            ${!r.origemImportada ? `<div class="upload-msg" style="margin-top:6px;color:var(--andamento);">⚠ o PER/DCOMP que constituiu este crédito (sem referência a outro PER/DCOMP) ainda não foi importado — o valor original e o saldo abaixo vêm só das compensações já importadas.</div>` : ''}
            ${r.outrasEmpresas.length ? `<div class="upload-msg err" style="margin-top:6px;">⚠ ${r.outrasEmpresas.length} documento(s) referenciam esta origem mas pertencem a outro CNPJ (${esc([...new Set(r.outrasEmpresas.map(m=>m.cnpj))].join(', '))}) — não entram no saldo por segurança, listados abaixo separadamente.</div>` : ''}
          </div>

          <div class="modal-section">
            <div class="st">PER/DCOMPs vinculados a esta origem (${r.members.length})</div>
            <div class="table-wrap">
              <div class="table-scroll" style="max-height:40vh">
                <table>
                  <thead><tr><th>Nº</th><th>Data</th><th>Natureza</th><th style="text-align:right">Utilizado</th><th style="text-align:right">Saldo após</th></tr></thead>
                  <tbody>
                  ${r.members.map(m => {
                    const mtype = classifyDocType(m);
                    return `<tr>
                    <td class="num">${esc(m.numero)}</td>
                    <td class="date">${esc(m.dataTransmissao||'—')}</td>
                    <td>${mtype ? `<span class="badge" style="color:var(${DOCTYPE_COLORS[mtype]});border-color:var(${DOCTYPE_COLORS[mtype]});background:color-mix(in srgb, var(${DOCTYPE_COLORS[mtype]}) 14%, transparent);">${DOCTYPE_LABELS[mtype]}</span>` : '—'}</td>
                    <td class="val">${fmtBRL(m.totalCreditoUtilizado)}</td>
                    <td class="val">${fmtBRL(m.saldoCreditoOriginal)}</td>
                  </tr>`;}).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          ${r.outrasEmpresas.length ? `
          <div class="modal-section">
            <div class="st" style="color:var(--neg)">Excluídos — CNPJ diferente (${r.outrasEmpresas.length})</div>
            <div class="table-wrap">
              <div class="table-scroll" style="max-height:30vh">
                <table>
                  <thead><tr><th>Nº</th><th>CNPJ</th><th>Empresa</th><th>Data</th></tr></thead>
                  <tbody>
                  ${r.outrasEmpresas.map(m => `<tr>
                    <td class="num">${esc(m.numero)}</td>
                    <td>${esc(m.cnpj||'—')}</td>
                    <td>${esc(m.nomeEmpresarial||'—')}</td>
                    <td class="date">${esc(m.dataTransmissao||'—')}</td>
                  </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>` : ''}
        </div>
      </div>`;
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay'){ state.modalRoot = null; renderModal(); }
    });
    document.getElementById('modalCloseBtn').addEventListener('click', () => { state.modalRoot = null; renderModal(); });
  }

  (async function init(){
    await loadClients();
    await loadRecordsForSelected();
    render();
  })();
})();
