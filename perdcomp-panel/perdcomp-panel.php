<?php
/**
 * Plugin Name: Painel PER/DCOMP · Conttinova
 * Description: Painel de controle de compensações PER/DCOMP com banco de dados compartilhado próprio (substitui a versão que rodava dentro do Claude). Use o shortcode [perdcomp_panel] numa página.
 * Version: 1.0.0
 * Author: Conttinova
 * Text Domain: perdcomp-panel
 *
 * Este plugin é o "backend próprio" que substitui o banco de dados e o download que, na
 * versão anterior do painel, eram fornecidos automaticamente pelo ambiente do Claude
 * (capabilities "db" e "downloads" de um Artifact publicado). Aqui:
 *   - "db"        -> uma tabela própria neste banco do WordPress, exposta por uma API REST
 *                    simples (perdcomp/v1/doc e perdcomp/v1/collection), com a MESMA forma
 *                    de "documento por caminho" que o app já usava (ver assets/app.js).
 *   - "downloads" -> não precisa de nada aqui: virou um download comum feito pelo próprio
 *                    navegador (Blob + <a download>), dentro do assets/app.js.
 *
 * Todo o resto (toda a lógica de negócio: PER/DCOMP, lançamentos contábeis, relatórios em
 * PDF, etc.) é o mesmo código já testado, só mudou onde ele busca/grava os dados.
 */

if (!defined('ABSPATH')) exit; // sem acesso direto

define('PERDCOMP_PANEL_VERSION', '1.0.0');
define('PERDCOMP_PANEL_CAP', 'perdcomp_access'); // capability que controla quem pode usar o painel
define('PERDCOMP_PANEL_OPTION_ROLES', 'perdcomp_panel_roles'); // option: quais papéis têm a capability acima
define('PERDCOMP_PANEL_TABLE', 'perdcomp_docs');

// ============================================================================================
// Ativação / desativação — cria a tabela e garante que Administrador sempre tem acesso.
// ============================================================================================

function perdcomp_panel_table_name(){
	global $wpdb;
	return $wpdb->prefix . PERDCOMP_PANEL_TABLE;
}

function perdcomp_panel_activate(){
	global $wpdb;
	$table = perdcomp_panel_table_name();
	$charset_collate = $wpdb->get_charset_collate();
	// path: VARCHAR(191) — mesmo limite clássico do WordPress pra colunas indexadas em
	// utf8mb4 (compatível até com bancos MySQL/MariaDB mais antigos). Os caminhos reais
	// usados pelo app (ex. "clients/acme-ltda/documentos/29720.12097.120626.1.3.02-7124")
	// nunca chegam perto disso.
	$sql = "CREATE TABLE {$table} (
		path VARCHAR(191) NOT NULL,
		data LONGTEXT NOT NULL,
		updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY  (path)
	) {$charset_collate};";
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	dbDelta($sql);

	// Administrador sempre tem acesso ao painel, mesmo antes de qualquer configuração.
	$admin = get_role('administrator');
	if ($admin && !$admin->has_cap(PERDCOMP_PANEL_CAP)){
		$admin->add_cap(PERDCOMP_PANEL_CAP);
	}
	if (get_option(PERDCOMP_PANEL_OPTION_ROLES) === false){
		add_option(PERDCOMP_PANEL_OPTION_ROLES, array('administrator'));
	}
}
register_activation_hook(__FILE__, 'perdcomp_panel_activate');

// Desativar o plugin NÃO apaga a tabela nem os dados dos clientes — só remove a capability
// dos papéis (pra ninguém acessar uma ferramenta que não está mais funcionando). Os dados
// ficam guardados; reativar o plugin restaura o acesso configurado.
function perdcomp_panel_deactivate(){
	foreach (wp_roles()->roles as $role_slug => $role_info){
		$role = get_role($role_slug);
		if ($role && $role->has_cap(PERDCOMP_PANEL_CAP)){
			$role->remove_cap(PERDCOMP_PANEL_CAP);
		}
	}
}
register_deactivation_hook(__FILE__, 'perdcomp_panel_deactivate');

// ============================================================================================
// Helpers de validação de "path" — o mesmo esquema genérico "caminho -> documento JSON" que
// o app já usava com o banco do Claude (clients/{slug}, clients/{slug}/documentos/{numero},
// clients/{slug}/config/lancamentos, clients/{slug}/creditos/{id}). O backend não precisa
// conhecer esse formato — só validar que é um caminho razoável, sem caracteres estranhos.
// ============================================================================================

function perdcomp_panel_valid_path($path){
	if (!is_string($path) || $path === '') return false;
	if (strlen($path) > 190) return false; // cabe na coluna (191) com folga
	// letras, números, underscore, hífen, ponto e barra — cobre slugs, nºs de PER/DCOMP
	// (que têm pontos e hífen) e os prefixos fixos ("clients/", "documentos/", etc.)
	return (bool) preg_match('/^[A-Za-z0-9_.\/-]+$/', $path);
}

function perdcomp_panel_row_by_path($path){
	global $wpdb;
	$table = perdcomp_panel_table_name();
	return $wpdb->get_row($wpdb->prepare("SELECT path, data FROM {$table} WHERE path = %s", $path));
}

// ============================================================================================
// Permissão — só quem tem a capability perdcomp_access (logado) pode ler/gravar qualquer
// coisa nesta API. Isso vale pra toda a rota, sem exceção: os dados são de clientes da
// contabilidade, não é conteúdo público.
// ============================================================================================

function perdcomp_panel_rest_permission(){
	return is_user_logged_in() && current_user_can(PERDCOMP_PANEL_CAP);
}

// ============================================================================================
// API REST — perdcomp/v1/doc e perdcomp/v1/collection
// ============================================================================================

add_action('rest_api_init', function(){

	// ---- GET/POST/PATCH/DELETE /perdcomp/v1/doc ----
	register_rest_route('perdcomp/v1', '/doc', array(
		array(
			'methods'             => WP_REST_Server::READABLE, // GET
			'callback'            => 'perdcomp_panel_rest_doc_get',
			'permission_callback' => 'perdcomp_panel_rest_permission',
			'args'                => array('path' => array('required' => true)),
		),
		array(
			'methods'             => WP_REST_Server::CREATABLE, // POST — grava/sobrescreve o documento inteiro
			'callback'            => 'perdcomp_panel_rest_doc_set',
			'permission_callback' => 'perdcomp_panel_rest_permission',
		),
		array(
			'methods'             => WP_REST_Server::EDITABLE, // PATCH — mescla campos no documento existente
			'callback'            => 'perdcomp_panel_rest_doc_update',
			'permission_callback' => 'perdcomp_panel_rest_permission',
		),
		array(
			'methods'             => WP_REST_Server::DELETABLE, // DELETE
			'callback'            => 'perdcomp_panel_rest_doc_delete',
			'permission_callback' => 'perdcomp_panel_rest_permission',
			'args'                => array('path' => array('required' => true)),
		),
	));

	// ---- GET/POST /perdcomp/v1/collection ----
	register_rest_route('perdcomp/v1', '/collection', array(
		array(
			'methods'             => WP_REST_Server::READABLE, // GET — lista os documentos diretamente "dentro" de path
			'callback'            => 'perdcomp_panel_rest_collection_get',
			'permission_callback' => 'perdcomp_panel_rest_permission',
			'args'                => array('path' => array('required' => true)),
		),
		array(
			'methods'             => WP_REST_Server::CREATABLE, // POST — cria um documento novo com id gerado
			'callback'            => 'perdcomp_panel_rest_collection_add',
			'permission_callback' => 'perdcomp_panel_rest_permission',
		),
	));
});

function perdcomp_panel_rest_doc_get(WP_REST_Request $req){
	$path = (string) $req->get_param('path');
	if (!perdcomp_panel_valid_path($path)) return new WP_Error('perdcomp_bad_path', 'Caminho inválido.', array('status' => 400));
	$row = perdcomp_panel_row_by_path($path);
	if (!$row) return array('exists' => false, 'data' => null);
	return array('exists' => true, 'data' => json_decode($row->data, true));
}

function perdcomp_panel_rest_doc_set(WP_REST_Request $req){
	global $wpdb;
	$body = $req->get_json_params();
	$path = isset($body['path']) ? (string) $body['path'] : '';
	if (!perdcomp_panel_valid_path($path)) return new WP_Error('perdcomp_bad_path', 'Caminho inválido.', array('status' => 400));
	if (!array_key_exists('data', $body)) return new WP_Error('perdcomp_bad_data', 'Campo "data" ausente.', array('status' => 400));
	$table = perdcomp_panel_table_name();
	$ok = $wpdb->replace($table, array(
		'path'       => $path,
		'data'       => wp_json_encode($body['data']),
		'updated_at' => current_time('mysql'),
	), array('%s', '%s', '%s'));
	if ($ok === false) return new WP_Error('perdcomp_db_error', 'Não consegui gravar no banco.', array('status' => 500));
	return array('ok' => true);
}

function perdcomp_panel_rest_doc_update(WP_REST_Request $req){
	global $wpdb;
	$body = $req->get_json_params();
	$path = isset($body['path']) ? (string) $body['path'] : '';
	if (!perdcomp_panel_valid_path($path)) return new WP_Error('perdcomp_bad_path', 'Caminho inválido.', array('status' => 400));
	if (!array_key_exists('data', $body) || !is_array($body['data'])) return new WP_Error('perdcomp_bad_data', 'Campo "data" precisa ser um objeto.', array('status' => 400));
	$row = perdcomp_panel_row_by_path($path);
	if (!$row) return new WP_Error('perdcomp_not_found', 'Documento não existe.', array('status' => 404));
	$current = json_decode($row->data, true);
	if (!is_array($current)) $current = array();
	$merged = array_merge($current, $body['data']);
	$table = perdcomp_panel_table_name();
	$ok = $wpdb->update($table, array('data' => wp_json_encode($merged), 'updated_at' => current_time('mysql')), array('path' => $path), array('%s', '%s'), array('%s'));
	if ($ok === false) return new WP_Error('perdcomp_db_error', 'Não consegui atualizar no banco.', array('status' => 500));
	return array('ok' => true);
}

function perdcomp_panel_rest_doc_delete(WP_REST_Request $req){
	global $wpdb;
	$path = (string) $req->get_param('path');
	if (!perdcomp_panel_valid_path($path)) return new WP_Error('perdcomp_bad_path', 'Caminho inválido.', array('status' => 400));
	$table = perdcomp_panel_table_name();
	$wpdb->delete($table, array('path' => $path), array('%s'));
	return array('ok' => true);
}

function perdcomp_panel_rest_collection_get(WP_REST_Request $req){
	global $wpdb;
	$path = (string) $req->get_param('path');
	if (!perdcomp_panel_valid_path($path)) return new WP_Error('perdcomp_bad_path', 'Caminho inválido.', array('status' => 400));
	$table = perdcomp_panel_table_name();
	$prefix = $path . '/';
	// Só os documentos DIRETAMENTE dentro de path (sem mais nenhuma "/" depois do prefixo)
	// — mesma semântica de "coleção" (nunca lista subcoleções aninhadas junto).
	$like_one_level   = $wpdb->esc_like($prefix) . '%';
	$like_two_levels  = $wpdb->esc_like($prefix) . '%/%';
	$rows = $wpdb->get_results($wpdb->prepare(
		"SELECT path, data FROM {$table} WHERE path LIKE %s AND path NOT LIKE %s",
		$like_one_level, $like_two_levels
	));
	$docs = array();
	foreach ($rows as $row){
		$docs[] = array(
			'id'   => substr($row->path, strlen($prefix)),
			'data' => json_decode($row->data, true),
		);
	}
	return array('docs' => $docs);
}

function perdcomp_panel_rest_collection_add(WP_REST_Request $req){
	global $wpdb;
	$body = $req->get_json_params();
	$path = isset($body['path']) ? (string) $body['path'] : '';
	if (!perdcomp_panel_valid_path($path)) return new WP_Error('perdcomp_bad_path', 'Caminho inválido.', array('status' => 400));
	if (!array_key_exists('data', $body)) return new WP_Error('perdcomp_bad_data', 'Campo "data" ausente.', array('status' => 400));
	$table = perdcomp_panel_table_name();
	// Gera um id novo (UUID) — colisão é praticamente impossível, mas tenta de novo uma vez
	// se cair numa que já existe, só por garantia.
	for ($attempt = 0; $attempt < 2; $attempt++){
		$id = str_replace('-', '', wp_generate_uuid4());
		$full_path = $path . '/' . $id;
		if (!perdcomp_panel_row_by_path($full_path)) break;
	}
	$ok = $wpdb->insert($table, array(
		'path'       => $full_path,
		'data'       => wp_json_encode($body['data']),
		'updated_at' => current_time('mysql'),
	), array('%s', '%s', '%s'));
	if ($ok === false) return new WP_Error('perdcomp_db_error', 'Não consegui gravar no banco.', array('status' => 500));
	return array('id' => $id);
}

// ============================================================================================
// Shortcode [perdcomp_panel] — enfileira CSS/JS e imprime a estrutura da página. Só carrega
// o app de verdade pra quem está logado E tem a capability perdcomp_access.
// ============================================================================================

function perdcomp_panel_shortcode(){
	if (!is_user_logged_in()){
		return '<p>Você precisa estar <a href="' . esc_url(wp_login_url(get_permalink())) . '">conectado</a> pra abrir o Painel PER/DCOMP.</p>';
	}
	if (!current_user_can(PERDCOMP_PANEL_CAP)){
		return '<p>Sua conta não tem acesso ao Painel PER/DCOMP. Peça a um administrador do site pra liberar em Ajustes → Painel PER/DCOMP.</p>';
	}

	wp_enqueue_style('perdcomp-fonts', 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap', array(), null);
	wp_enqueue_style('perdcomp-app', plugins_url('assets/app.css', __FILE__), array(), PERDCOMP_PANEL_VERSION);

	wp_enqueue_script('perdcomp-pdfjs', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', array(), null, true);
	wp_enqueue_script('perdcomp-jspdf', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', array(), null, true);
	wp_enqueue_script('perdcomp-jspdf-autotable', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js', array('perdcomp-jspdf'), null, true);
	wp_enqueue_script('perdcomp-app', plugins_url('assets/app.js', __FILE__), array('perdcomp-pdfjs', 'perdcomp-jspdf', 'perdcomp-jspdf-autotable'), PERDCOMP_PANEL_VERSION, true);
	wp_localize_script('perdcomp-app', 'perdcompConfig', array(
		'root'  => esc_url_raw(rest_url('perdcomp/v1/')),
		'nonce' => wp_create_nonce('wp_rest'),
	));

	ob_start();
	?>
	<div id="perdcomp-panel-root">
		<div id="dbBanner"></div>
		<div class="app">
			<aside class="sidebar">
				<div class="brand">
					<span class="brand-wordmark">Contti<b>nova</b></span>
					<span class="eyebrow">Livro de Protocolo PER/DCOMP · Compartilhado</span>
				</div>
				<button class="add-client-btn" id="addClientBtn">+ Adicionar cliente</button>
				<ul class="client-list" id="clientList"></ul>
			</aside>
			<main class="main" id="mainArea"></main>
		</div>
		<div id="modalArea"></div>
		<input type="file" id="pdfInput" accept="application/pdf" multiple style="display:none" />
	</div>
	<?php
	return ob_get_clean();
}
add_shortcode('perdcomp_panel', 'perdcomp_panel_shortcode');

// ============================================================================================
// Página de configurações (Ajustes → Painel PER/DCOMP) — escolher quais papéis do WordPress
// podem usar o painel. Administrador sempre tem acesso (não aparece na lista pra desmarcar).
// ============================================================================================

add_action('admin_menu', function(){
	add_options_page(
		'Painel PER/DCOMP',
		'Painel PER/DCOMP',
		'manage_options',
		'perdcomp-panel',
		'perdcomp_panel_settings_page'
	);
});

function perdcomp_panel_settings_page(){
	if (!current_user_can('manage_options')) return;

	if (isset($_POST['perdcomp_panel_save']) && check_admin_referer('perdcomp_panel_settings')){
		$selected = isset($_POST['perdcomp_roles']) && is_array($_POST['perdcomp_roles'])
			? array_map('sanitize_key', wp_unslash($_POST['perdcomp_roles']))
			: array();
		$selected[] = 'administrator'; // sempre incluso
		$selected = array_unique($selected);

		foreach (wp_roles()->roles as $role_slug => $role_info){
			$role = get_role($role_slug);
			if (!$role) continue;
			if (in_array($role_slug, $selected, true)){
				if (!$role->has_cap(PERDCOMP_PANEL_CAP)) $role->add_cap(PERDCOMP_PANEL_CAP);
			} else {
				if ($role->has_cap(PERDCOMP_PANEL_CAP)) $role->remove_cap(PERDCOMP_PANEL_CAP);
			}
		}
		update_option(PERDCOMP_PANEL_OPTION_ROLES, $selected);
		echo '<div class="notice notice-success"><p>Acesso atualizado.</p></div>';
	}

	$saved_roles = get_option(PERDCOMP_PANEL_OPTION_ROLES, array('administrator'));
	?>
	<div class="wrap">
		<h1>Painel PER/DCOMP</h1>
		<p>Escolha quais papéis do WordPress podem abrir o Painel PER/DCOMP (a página que tiver o shortcode <code>[perdcomp_panel]</code>). Administrador sempre tem acesso.</p>
		<form method="post">
			<?php wp_nonce_field('perdcomp_panel_settings'); ?>
			<table class="form-table" role="presentation">
				<tbody>
				<?php foreach (wp_roles()->roles as $role_slug => $role_info): ?>
					<?php if ($role_slug === 'administrator') continue; ?>
					<tr>
						<th scope="row"><?php echo esc_html($role_info['name']); ?></th>
						<td>
							<label>
								<input type="checkbox" name="perdcomp_roles[]" value="<?php echo esc_attr($role_slug); ?>" <?php checked(in_array($role_slug, $saved_roles, true)); ?> />
								Pode acessar o Painel PER/DCOMP
							</label>
						</td>
					</tr>
				<?php endforeach; ?>
				<tr>
					<th scope="row">Administrador</th>
					<td>Sempre tem acesso.</td>
				</tr>
				</tbody>
			</table>
			<p class="submit">
				<button type="submit" name="perdcomp_panel_save" class="button button-primary">Salvar</button>
			</p>
		</form>
		<hr />
		<p>Pra usar o painel, crie (ou edite) uma página do WordPress e cole <code>[perdcomp_panel]</code> no conteúdo dela. Essa página deve ficar acessível só pra quem está logado (ex.: use um tema/plugin de restrição de acesso, ou deixe a URL só divulgada internamente) — o painel guarda dados de clientes da contabilidade, não é conteúdo pra visitantes.</p>
	</div>
	<?php
}
