const SUPABASE_URL = "https://vgfogjidrfbnvpakleku.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZnZm9namlkcmZibnZwYWtsZWt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NDkwNDAsImV4cCI6MjEwNDUyNTA0MH0.MPbEbyMPxp5j1mpirQefa-R42t1axc4HUtYH9TW8mHg";

const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let isAdmin = false;
let canWrite = false;
let currentProfile = null;
let editingTournament = null;
let editingResume = null;
let pendingRegistration = null;
let tournamentData = [];
let resumeData = [];
let tournamentLoadState = "loading";
let tournamentMatchesAvailable = false;
let resumeLoadState = "loading";
let authVersion = 0;
const defaultHomeMessage = "愿我们都能听见，\n雪落下的声音。";
let homeMessage = "";
let homeMessageBusy = false;

const adminForm = document.getElementById("adminForm");
const adminLogout = document.getElementById("adminLogout");
const adminStatus = document.getElementById("adminStatus");

function normalizeUsername(value) {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_\u4e00-\u9fff]{3,24}$/.test(username)) {
    throw new Error("用户名需为 3 至 24 位中文、字母、数字或下划线。");
  }
  if (new TextEncoder().encode(username).length > 30) {
    throw new Error("用户名过长，中文最多 10 个字。");
  }
  return username;
}

function emailForNewUsername(username) {
  const hex = Array.from(new TextEncoder().encode(username),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  // Use the project's real hostname; Auth rejects the reserved .example TLD.
  return `u${hex}@${new URL(SUPABASE_URL).hostname}`;
}

async function updateAdmin(session) {
  const version = ++authVersion;
  isAdmin = false;
  canWrite = false;
  currentProfile = null;
  adminForm.hidden = Boolean(session);
  adminLogout.hidden = !session;
  if (!session) {
    homeMessage = "";
    renderAdminControls();
    showStatus(adminStatus, "未登录，可以查看内容。登录后可提交、修改和删除。");
    return;
  }
  showStatus(adminStatus, "正在验证用户权限...");
  try {
    const { data, error } = await sbClient.auth.getUser();
    if (version !== authVersion) return;
    if (error) throw error;
    const { data: profile, error: profileError } = await sbClient
      .from("user_profiles").select("id, username, is_admin, disabled")
      .eq("id", data.user.id).single();
    if (version !== authVersion) return;
    if (profileError) throw profileError;
    currentProfile = profile;
    homeMessage = validHomeMessage(data.user.user_metadata?.home_message);
    isAdmin = profile.is_admin && !profile.disabled;
    canWrite = !profile.disabled;
    showStatus(adminStatus, profile.disabled
      ? `${profile.username}：操作权限已被禁用，仍可查看。`
      : `${profile.username} 已登录${isAdmin ? "（管理员）" : ""}，可以操作全部内容。`);
  } catch (error) {
    if (version !== authVersion) return;
    homeMessage = "";
    showStatus(adminStatus, "身份验证失败：" + error.message, "error");
  }
  renderAdminControls();
  if (isAdmin) loadUsers();
}

function renderAdminControls() {
  document.getElementById("t_actions").hidden = !canWrite;
  document.getElementById("t_fields").disabled = !canWrite;
  document.getElementById("r_fields").disabled = !canWrite;
  document.getElementById("userManagement").hidden = !isAdmin;
  document.getElementById("userManagementMenu").hidden = !isAdmin;
  const userPage = document.getElementById("page-users");
  userPage.hidden = !isAdmin;
  if (!isAdmin) {
    document.getElementById("userList").replaceChildren();
    if (userPage.classList.contains("active")) selectPage("home");
  }
  document.getElementById("home-access").textContent = canWrite
    ? "已登录，可提交、修改和删除内容"
    : currentProfile?.disabled
      ? "操作权限已禁用，仍可查看全部记录"
      : "当前可查看全部公开记录";
  renderTournaments(tournamentData);
  renderResumes(resumeData);
  renderHomeMessage();
}

function validHomeMessage(value) {
  if (typeof value !== "string") return "";
  const message = value.trim();
  return message.length <= 120 && !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(message)
    ? message : "";
}

function renderHomeMessage() {
  document.getElementById("home-title").textContent = homeMessage || defaultHomeMessage;
  const button = document.getElementById("editHomeMessage");
  button.textContent = currentProfile
    ? homeMessage ? "修改我的首页语" : "添加我的首页语"
    : "登陆来修改我的首页语";
  button.disabled = homeMessageBusy || Boolean(currentProfile && !canWrite);
  if (!canWrite) {
    document.getElementById("homeMessageForm").hidden = true;
    document.getElementById("homeMessageInput").value = "";
    button.setAttribute("aria-expanded", "false");
  }
}

document.getElementById("editHomeMessage").addEventListener("click", () => {
  if (!currentProfile) {
    document.getElementById("adminPanel").open = true;
    document.getElementById("adminUsername").focus();
    document.getElementById("adminPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (!canWrite || homeMessageBusy) return;
  document.getElementById("homeMessageForm").hidden = false;
  document.getElementById("editHomeMessage").setAttribute("aria-expanded", "true");
  document.getElementById("homeMessageInput").value = homeMessage;
  showStatus(document.getElementById("homeMessageStatus"), "");
  document.getElementById("homeMessageInput").focus();
});

document.getElementById("cancelHomeMessage").addEventListener("click", () => {
  document.getElementById("homeMessageForm").hidden = true;
  document.getElementById("homeMessageInput").value = "";
  document.getElementById("editHomeMessage").setAttribute("aria-expanded", "false");
  document.getElementById("editHomeMessage").focus();
});

document.getElementById("homeMessageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canWrite || !currentProfile || homeMessageBusy) return;
  const status = document.getElementById("homeMessageStatus");
  const message = validHomeMessage(document.getElementById("homeMessageInput").value);
  if (!message) {
    showStatus(status, "首页语需为 1 至 120 个字符，不能包含 emoji。", "error");
    return;
  }
  const userId = currentProfile.id;
  homeMessageBusy = true;
  document.getElementById("saveHomeMessage").disabled = true;
  document.getElementById("cancelHomeMessage").disabled = true;
  document.getElementById("homeMessageInput").disabled = true;
  document.getElementById("editHomeMessage").disabled = true;
  showStatus(status, "保存中...");
  try {
    await refreshPermissions();
    if (!canWrite || currentProfile?.id !== userId) throw new Error("登录或权限已变化，请重新登录后再试。");
    // Store personal display text separately from shared content and trusted roles.
    const { error } = await sbClient.auth.updateUser({ data: { home_message: message } });
    if (error) throw error;
    await refreshPermissions();
    document.getElementById("homeMessageForm").hidden = true;
    document.getElementById("editHomeMessage").setAttribute("aria-expanded", "false");
    showStatus(status, currentProfile?.id === userId ? "首页语已保存。" : "", "success");
  } catch (error) {
    showStatus(status, "保存失败：" + error.message, "error");
  } finally {
    homeMessageBusy = false;
    document.getElementById("saveHomeMessage").disabled = false;
    document.getElementById("cancelHomeMessage").disabled = false;
    document.getElementById("homeMessageInput").disabled = false;
    renderHomeMessage();
  }
});

adminForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = adminForm.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus(adminStatus, "登录中...");
  try {
    const username = normalizeUsername(document.getElementById("adminUsername").value);
    const password = document.getElementById("adminPassword").value;
    const { data: email, error: lookupError } = await sbClient
      .rpc("lookup_username", { requested_username: username });
    if (lookupError) throw lookupError;
    if (!email) {
      if (password.length < 6) throw new Error("新账号密码至少需要 6 位。");
      pendingRegistration = { username, password };
      document.getElementById("registerUsername").textContent = `用户名：${username}`;
      document.getElementById("confirmPassword").value = "";
      showStatus(document.getElementById("registerStatus"), "");
      document.getElementById("registerDialog").showModal();
      return;
    }
    const { error } = await sbClient.auth.signInWithPassword({
      email, password,
    });
    if (error) throw error;
    document.getElementById("adminPassword").value = "";
  } catch (error) {
    showStatus(adminStatus, "登录失败：" + error.message, "error");
  } finally {
    button.disabled = false;
  }
});

const registerDialog = document.getElementById("registerDialog");
let registrationBusy = false;
document.getElementById("cancelRegister").addEventListener("click", () => registerDialog.close());
registerDialog.addEventListener("cancel", (e) => {
  if (registrationBusy) e.preventDefault();
});
registerDialog.addEventListener("close", () => {
  pendingRegistration = null;
  document.getElementById("confirmPassword").value = "";
  document.getElementById("adminPassword").value = "";
});
document.getElementById("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingRegistration) return;
  const status = document.getElementById("registerStatus");
  if (document.getElementById("confirmPassword").value !== pendingRegistration.password) {
    showStatus(status, "两次密码不一致，请重新确认。", "error");
    return;
  }
  const button = e.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  registrationBusy = true;
  document.getElementById("cancelRegister").disabled = true;
  try {
    const { username, password } = pendingRegistration;
    const { data, error } = await sbClient.auth.signUp({
      email: emailForNewUsername(username), password,
      options: { data: { username } },
    });
    if (error) throw error;
    if (!data.session) throw new Error("后台尚未关闭邮箱确认，请联系管理员完成配置。");
    registerDialog.close();
  } catch (error) {
    showStatus(status, "注册失败：" + error.message, "error");
  } finally {
    button.disabled = false;
    registrationBusy = false;
    document.getElementById("cancelRegister").disabled = false;
  }
});

async function loadUsers() {
  if (!isAdmin) return;
  const status = document.getElementById("userStatus");
  try {
    const { data, error } = await sbClient.from("user_profiles")
      .select("id, username, is_admin, disabled").eq("is_admin", false).order("username");
    if (error) throw error;
    if (!isAdmin) return;
    const list = document.getElementById("userList");
    list.replaceChildren();
    for (const user of data) {
      if (user.is_admin) continue;
      const row = document.createElement("div");
      row.className = "form-actions";
      const label = document.createElement("span");
      label.textContent = `${user.username}：${user.disabled ? "仅可查看" : "可操作"}`;
      row.appendChild(label);
      if (!user.is_admin) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-outline";
        button.textContent = user.disabled ? "恢复权限" : "禁止操作";
        button.addEventListener("click", async () => {
          if (!window.confirm(`确定${user.disabled ? "恢复" : "禁止"} ${user.username} 的操作权限吗？`)) return;
          button.disabled = true;
          try {
            const { error } = await sbClient.rpc("set_user_disabled", {
              target_user: user.id, new_disabled: !user.disabled,
            });
            if (error) throw error;
            showStatus(status, "权限已更新。", "success");
            await loadUsers();
          } catch (error) {
            showStatus(status, "操作失败：" + error.message, "error");
          } finally { button.disabled = false; }
        });
        row.appendChild(button);
      }
      list.appendChild(row);
    }
  } catch (error) { showStatus(status, "加载用户失败：" + error.message, "error"); }
}
document.getElementById("refreshUsers").addEventListener("click", loadUsers);

adminLogout.addEventListener("click", async () => {
  adminLogout.disabled = true;
  try {
    const { error } = await sbClient.auth.signOut();
    if (error) throw error;
  } catch (error) {
    showStatus(adminStatus, "退出失败：" + error.message, "error");
  } finally {
    adminLogout.disabled = false;
  }
});

// Defer auth requests until the authentication callback has released its lock.
sbClient.auth.onAuthStateChange((_event, session) => {
  isAdmin = false;
  canWrite = false;
  setTimeout(() => updateAdmin(session), 0);
});

// Recheck permissions after a tab is resumed and while it remains open.
window.addEventListener("focus", refreshPermissions);
setInterval(refreshPermissions, 30000);
async function refreshPermissions() {
  const { data, error } = await sbClient.auth.getSession();
  if (!error) await updateAdmin(data.session);
}

/* ========= 侧边栏 & 页面切换 ========= */
const sidebar = document.getElementById("sidebar");
const toggleSidebarBtn = document.getElementById("toggleSidebar");

toggleSidebarBtn.addEventListener("click", () => {
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle("expanded-mobile");
  } else {
    sidebar.classList.toggle("collapsed");
  }
  updateSidebarAccessibility();
});

function updateSidebarAccessibility() {
  const expanded = window.innerWidth <= 768
    ? sidebar.classList.contains("expanded-mobile")
    : !sidebar.classList.contains("collapsed");
  toggleSidebarBtn.setAttribute("aria-expanded", String(expanded));
  sidebar.inert = !expanded;
}
window.addEventListener("resize", updateSidebarAccessibility);
updateSidebarAccessibility();

document.querySelectorAll(".menu-item, [data-home-page]").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    if (!selectPage(item.dataset.page || item.dataset.homePage)) return;
    if (window.innerWidth <= 768) {
      sidebar.classList.remove("expanded-mobile");
      updateSidebarAccessibility();
    }
  });
});

function selectPage(target) {
  if (target === "users" && !isAdmin) return false;
  const targetPage = document.getElementById("page-" + target);
  if (!targetPage) return false;
  document.querySelectorAll(".menu-item").forEach((item) => {
    const selected = item.dataset.page === target;
    item.classList.toggle("active", selected);
    if (selected) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("active", page.id === "page-" + target);
  });
  targetPage.querySelector('h2[tabindex="-1"]')?.focus({ preventScroll: true });
  return true;
}

function updateHomeStats() {
  document.getElementById("home-tournaments").textContent =
    tournamentLoadState === "ready" ? tournamentData.length : "--";
  document.getElementById("home-resumes").textContent =
    resumeLoadState === "ready" ? resumeData.length : "--";
  document.getElementById("home-records").textContent = resumeLoadState === "ready"
    ? resumeData.reduce((total, resume) =>
      total + (Array.isArray(resume.records) ? resume.records.length : 0), 0)
    : "--";
  document.getElementById("home-data-status").textContent =
    tournamentLoadState === "error" || resumeLoadState === "error"
      ? "部分数据未能加载，请检查网络并刷新页面。"
      : tournamentLoadState === "loading" || resumeLoadState === "loading"
        ? "正在加载数据概览..."
        : "";
}

/* ========= 工具函数 ========= */
function showStatus(el, text, type = "") {
  el.textContent = text;
  el.className = "status " + type;
  if (type === "success") {
    setTimeout(() => {
      if (el.textContent === text) {
        el.textContent = "";
        el.className = "status";
      }
    }, 3500);
  }
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  } catch (e) {
    return iso || "";
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

async function deleteRecord(button, table, description, status, reload) {
  if (!canWrite || button.disabled) return;
  const id = button.dataset.deleteId;
  // Cloud tables use UUIDs; locally created tables may use numeric IDs.
  if (typeof id !== "string" || !/^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)) {
    showStatus(status, "记录编号无效，请刷新列表后重试。", "error");
    return;
  }
  if (!window.confirm(`确定永久删除${description}吗？此操作不可撤销。`)) return;
  button.disabled = true;
  showStatus(status, "删除中...");
  try {
    const { data, error } = await sbClient
      .from(table)
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw error;
    // RLS can silently match no rows. Do not report that as a successful delete.
    if (!data || data.length !== 1) {
      throw new Error("未删除记录，请检查操作权限或刷新列表后重试。");
    }
    showStatus(status, "已删除。", "success");
    await reload();
  } catch (error) {
    showStatus(status, "删除失败：" + error.message, "error");
  } finally {
    button.disabled = false;
  }
}

/* ========= 赛事统计 ========= */
const tResult = document.getElementById("t_result");
const tResultOther = document.getElementById("t_result_other");
const tournamentForm = document.getElementById("tournamentForm");
const tStatus = document.getElementById("t_status");
const tBody = document.getElementById("t_body");
const tCount = document.getElementById("t_count");
const tDeleteStatus = document.getElementById("t_delete_status");
const tMatches = document.getElementById("t_matches");
let matchInputSequence = 0;

function addMatchRow(match = {}) {
  if (!match || typeof match !== "object") match = {};
  const row = document.createElement("fieldset");
  row.className = "match-editor";
  const prefix = `match-${++matchInputSequence}`;
  row.innerHTML = `
    <legend class="match-number"></legend>
    <div class="form-grid">
      <div class="form-row"><label for="${prefix}-round">轮次 / 场次</label><input id="${prefix}-round" type="text" class="match-round" /></div>
      <div class="form-row"><label for="${prefix}-opponent">对手队伍</label><input id="${prefix}-opponent" type="text" class="match-opponent" /></div>
      <div class="form-row"><label for="${prefix}-debaters">我方参赛选手</label><input id="${prefix}-debaters" type="text" class="match-debaters" /></div>
      <div class="form-row"><label for="${prefix}-outcome">胜负情况</label><select id="${prefix}-outcome" class="match-outcome"><option value="">请选择</option><option value="胜">胜</option><option value="负">负</option><option value="平">平</option><option value="待定">待定</option></select></div>
      <div class="form-row"><label for="${prefix}-votes-for">我方票数</label><input id="${prefix}-votes-for" type="number" class="match-votes-for" min="0" step="1" /></div>
      <div class="form-row"><label for="${prefix}-votes-against">对方票数</label><input id="${prefix}-votes-against" type="number" class="match-votes-against" min="0" step="1" /></div>
      <div class="form-row"><label for="${prefix}-best">最佳辩手</label><input id="${prefix}-best" type="text" class="match-best" /></div>
    </div>
    <div class="form-actions"><button type="button" class="btn-outline" data-remove-match>移除此场</button></div>
  `;
  const values = {
    ".match-round": match.round,
    ".match-opponent": match.opponent,
    ".match-debaters": match.debaters,
    ".match-outcome": match.outcome,
    ".match-votes-for": match.votes_for,
    ".match-votes-against": match.votes_against,
    ".match-best": match.best_debater,
  };
  for (const [selector, value] of Object.entries(values)) {
    row.querySelector(selector).value = value ?? "";
  }
  tMatches.appendChild(row);
  renumberMatches();
}

function renumberMatches() {
  tMatches.querySelectorAll(".match-number").forEach((legend, index) => {
    legend.textContent = `第 ${index + 1} 场比赛`;
  });
}

document.getElementById("addMatchBtn").addEventListener("click", () => {
  if (!canWrite) return;
  addMatchRow();
  tMatches.lastElementChild.querySelector("input").focus();
});
tMatches.addEventListener("click", (e) => {
  const button = e.target.closest("[data-remove-match]");
  if (!button || !canWrite) return;
  button.closest(".match-editor").remove();
  renumberMatches();
});

function collectTournamentMatches() {
  const matches = [];
  tMatches.querySelectorAll(".match-editor").forEach((row, index) => {
    const read = (selector) => row.querySelector(selector).value.trim();
    const round = read(".match-round");
    const opponent = read(".match-opponent");
    const debaters = read(".match-debaters");
    const outcome = read(".match-outcome");
    const votesFor = read(".match-votes-for");
    const votesAgainst = read(".match-votes-against");
    const bestDebater = read(".match-best");
    if (![round, opponent, debaters, outcome, votesFor, votesAgainst, bestDebater].some(Boolean)) return;
    if (!opponent || !debaters || !["胜", "负", "平", "待定"].includes(outcome)) {
      throw new Error(`请填写第 ${index + 1} 场的对手队伍、我方参赛选手和胜负情况。`);
    }
    const parseVotes = (value) => {
      if (value === "") return null;
      const votes = Number(value);
      if (!Number.isSafeInteger(votes) || votes < 0) {
        throw new Error(`第 ${index + 1} 场的票数必须为非负整数。`);
      }
      return votes;
    };
    matches.push({
      round, opponent, debaters, outcome,
      votes_for: parseVotes(votesFor), votes_against: parseVotes(votesAgainst),
      best_debater: bestDebater,
    });
  });
  return matches;
}

function summarizeMatchDebaters(matches) {
  return [...new Set(matches.flatMap((match) =>
    match.debaters.split(/[,，、;；\n]+/).map((name) => name.trim()).filter(Boolean)
  ))].join("、");
}

tBody.addEventListener("click", (e) => {
  const editButton = e.target.closest("[data-edit-id]");
  if (editButton && canWrite) {
    const record = tournamentData.find((r) => String(r.id) === editButton.dataset.editId);
    if (!record) return;
    editingTournament = record.id;
    document.getElementById("t_name").value = record.name;
    tResult.value = record.result;
    tResultOther.value = record.result_other || "";
    tResultOther.classList.toggle("hidden", record.result !== "其他");
    document.getElementById("t_debaters").value = record.debaters;
    tMatches.replaceChildren();
    for (const match of Array.isArray(record.matches) ? record.matches : []) addMatchRow(match);
    if (!tMatches.children.length) addMatchRow();
    document.getElementById("t_form_title").textContent = "修改赛事";
    tournamentForm.querySelector('button[type="submit"]').textContent = "保存修改";
    document.getElementById("t_cancel_edit").hidden = false;
    tournamentForm.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const button = e.target.closest("[data-delete-id]");
  if (!button) return;
  const name = button.closest("tr").children[1].textContent;
  deleteRecord(button, "tournaments", `赛事“${name}”（不会删除个人履历）`,
    tDeleteStatus, loadTournaments);
});

tResult.addEventListener("change", () => {
  tResultOther.classList.toggle("hidden", tResult.value !== "其他");
});

tournamentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canWrite) { showStatus(tStatus, "请先登录，或联系管理员恢复权限。", "error"); return; }
  const name = document.getElementById("t_name").value.trim();
  let result = tResult.value;
  let resultOther = null;
  let matches;
  try {
    matches = collectTournamentMatches();
  } catch (error) {
    showStatus(tStatus, error.message, "error");
    return;
  }
  if (!tournamentMatchesAvailable) {
    showStatus(tStatus, tournamentLoadState === "error"
      ? "赛事数据尚未加载成功，请检查网络并刷新后重试。"
      : tournamentLoadState === "loading"
        ? "正在加载赛事，请稍后重试。"
        : "请先在 Supabase 执行 006_tournament_matches.sql，再刷新页面后保存赛事。", "error");
    return;
  }
  const debaters = document.getElementById("t_debaters").value.trim() || summarizeMatchDebaters(matches);

  if (!name || !result || !debaters) {
    showStatus(tStatus, "请填写所有必填项", "error");
    return;
  }

  if (result === "其他") {
    resultOther = tResultOther.value.trim();
    if (!resultOther) {
      showStatus(tStatus, "请填写其他赛果内容", "error");
      return;
    }
  }

  const btn = tournamentForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  showStatus(tStatus, "提交中...");

  try {
    const payload = { name, result, result_other: resultOther, debaters, matches };
    const request = editingTournament !== null
      ? sbClient.from("tournaments").update(payload).eq("id", editingTournament)
      : sbClient.from("tournaments").insert([payload]);
    const { data, error } = await request.select("id");
    if (error) throw error;
    if (data?.length !== 1) throw new Error("未保存，请检查权限或刷新列表后重试。");
    showStatus(tStatus, editingTournament !== null ? "赛事修改成功！" : "赛事已上传成功！", "success");
    resetTournamentForm();
    await loadTournaments();
  } catch (error) {
    showStatus(tStatus, "保存失败：" + error.message, "error");
  } finally {
    btn.disabled = false;
  }
});

function resetTournamentForm() {
  editingTournament = null;
  tournamentForm.reset();
  tMatches.replaceChildren();
  addMatchRow();
  tResultOther.classList.add("hidden");
  document.getElementById("t_form_title").textContent = "上传新的赛事";
  tournamentForm.querySelector('button[type="submit"]').textContent = "提交赛事";
  document.getElementById("t_cancel_edit").hidden = true;
}
document.getElementById("t_cancel_edit").addEventListener("click", resetTournamentForm);

function tournamentResultTag(r, other) {
  const text = r === "其他" ? (other || "其他") : r;
  return `<span class="tag">${escapeHtml(text)}</span>`;
}

async function loadTournaments() {
  let { data, error } = await sbClient
    .from("tournaments")
    .select("id, name, result, result_other, debaters, matches, created_at")
    .order("created_at", { ascending: false });

  // Continue showing old records until the additive migration is installed.
  tournamentMatchesAvailable = !error;
  const schemaStatus = document.getElementById("t_schema_status");
  const missingMatches = error && ["42703", "PGRST204"].includes(error.code)
    && /matches/i.test(error.message);
  if (missingMatches) {
    ({ data, error } = await sbClient.from("tournaments")
      .select("id, name, result, result_other, debaters, created_at")
      .order("created_at", { ascending: false }));
    schemaStatus.hidden = false;
    showStatus(schemaStatus, "比赛明细尚未启用。请在 Supabase 执行 006_tournament_matches.sql，再刷新页面。旧赛事仍可查看。");
  } else {
    schemaStatus.hidden = true;
  }

  if (error) {
    tournamentLoadState = "error";
    updateHomeStats();
    tBody.innerHTML =
      `<tr><td colspan="${canWrite ? 6 : 5}" class="empty-row">加载失败，请检查网络。</td></tr>`;
    console.error(error);
    return;
  }

  tournamentData = data || [];
  tournamentLoadState = "ready";
  renderTournaments(tournamentData);
}

function renderTournaments(data) {
  updateHomeStats();
  tCount.textContent = "共 " + data.length + " 条";

  if (!data || data.length === 0) {
    tBody.innerHTML =
      `<tr><td colspan="${canWrite ? 6 : 5}" class="empty-row">暂无赛事记录，登录后可添加。</td></tr>`;
    return;
  }

  tBody.innerHTML = data
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${tournamentResultTag(r.result, r.result_other)}</td>
      <td>${escapeHtml(r.debaters)}</td>
      <td>${formatDate(r.created_at)}</td>
      ${canWrite ? `<td><div class="resume-actions"><button type="button" class="btn-outline" data-edit-id="${escapeHtml(r.id)}">修改</button><button type="button" class="btn-danger" data-delete-id="${escapeHtml(r.id)}">删除</button></div></td>` : ""}
    </tr>
    <tr class="tournament-detail-row"><td colspan="${canWrite ? 6 : 5}">${renderTournamentMatches(r.matches)}</td></tr>
  `
    )
    .join("");
}

function renderTournamentMatches(value) {
  const matches = Array.isArray(value) ? value : [];
  const rows = matches.map((match, index) => {
    const m = match && typeof match === "object" ? match : {};
    const votes = (value) => Number.isSafeInteger(value) && value >= 0 ? value : "未录入";
    return `<tr><td>${escapeHtml(m.round || `第 ${index + 1} 场`)}</td><td>${escapeHtml(m.debaters)}</td><td>${escapeHtml(m.opponent)}</td><td>${escapeHtml(m.outcome || "待定")}</td><td>${votes(m.votes_for)} : ${votes(m.votes_against)}</td><td>${escapeHtml(m.best_debater || "未录入")}</td></tr>`;
  }).join("");
  return `<details class="tournament-matches">
    <summary>比赛明细（共 ${matches.length} 场）</summary>
    ${matches.length ? `<div class="table-wrap"><table class="data-table match-detail-table"><thead><tr><th>轮次 / 场次</th><th>我方参赛选手</th><th>对手队伍</th><th>胜负</th><th>票数（我方 : 对方）</th><th>最佳辩手</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="field-note">尚未录入比赛明细。</p>'}
  </details>`;
}

/* ========= 履历统计 - 动态表格 ========= */
const rTbody = document.getElementById("r_tbody");
const addRowBtn = document.getElementById("addRowBtn");
const resumeForm = document.getElementById("resumeForm");
const rStatus = document.getElementById("r_status");
const rList = document.getElementById("r_list");
const rCount = document.getElementById("r_count");
const rDeleteStatus = document.getElementById("r_delete_status");

rList.addEventListener("click", (e) => {
  const editButton = e.target.closest("[data-edit-id]");
  if (editButton && canWrite) {
    const record = resumeData.find((r) => String(r.id) === editButton.dataset.editId);
    if (!record) return;
    editingResume = record.id;
    document.getElementById("r_grade").value = record.grade;
    document.getElementById("r_name").value = record.name;
    rTbody.replaceChildren();
    for (const row of record.records || []) addResumeRow(row);
    document.getElementById("r_form_title").textContent = "修改履历";
    resumeForm.querySelector('button[type="submit"]').textContent = "保存修改";
    document.getElementById("r_cancel_edit").hidden = false;
    resumeForm.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const button = e.target.closest("[data-delete-id]");
  if (!button) return;
  const name = button.closest(".resume-card").querySelector(".name").textContent;
  deleteRecord(button, "resumes", `“${name}”的整份履历（含全部履历记录）`,
    rDeleteStatus, loadResumes);
});

function addResumeRow(record = {}) {
  const idx = rTbody.querySelectorAll("tr").length + 1;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="row-idx">${idx}</td>
    <td><input type="text" class="r_tournament" placeholder="" /></td>
    <td>
      <select class="r_role">
        <option value="参赛">参赛</option>
        <option value="单场最佳">单场最佳</option>
        <option value="全程最佳">全程最佳</option>
      </select>
    </td>
    <td><button type="button" class="btn-danger remove-row">删除</button></td>
  `;
  tr.querySelector(".r_tournament").value = record.tournament || "";
  tr.querySelector(".r_role").value = record.role || "参赛";
  tr.querySelector(".remove-row").addEventListener("click", () => {
    tr.remove();
    refreshRowIndex();
  });
  rTbody.appendChild(tr);
}

function refreshRowIndex() {
  rTbody
    .querySelectorAll("tr")
    .forEach((tr, i) => (tr.querySelector(".row-idx").textContent = i + 1));
}

addRowBtn.addEventListener("click", () => addResumeRow());

/* ========= 履历统计 - 提交 ========= */
resumeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canWrite) { showStatus(rStatus, "请先登录，或联系管理员恢复权限。", "error"); return; }
  const grade = document.getElementById("r_grade").value.trim();
  const name = document.getElementById("r_name").value.trim();

  if (!grade || !name) {
    showStatus(rStatus, "请填写年级和姓名", "error");
    return;
  }

  const rows = rTbody.querySelectorAll("tr");
  const records = [];
  for (const tr of rows) {
    const tn = tr.querySelector(".r_tournament").value.trim();
    const rl = tr.querySelector(".r_role").value;
    if (!tn) {
      showStatus(rStatus, "存在未填写的赛事名称", "error");
      return;
    }
    records.push({ tournament: tn, role: rl });
  }

  if (records.length === 0) {
    showStatus(rStatus, "请至少添加一条履历记录", "error");
    return;
  }

  const btn = resumeForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  showStatus(rStatus, "提交中...");

  try {
    const payload = { grade, name, records };
    const request = editingResume !== null
      ? sbClient.from("resumes").update(payload).eq("id", editingResume)
      : sbClient.from("resumes").insert([payload]);
    const { data, error } = await request.select("id");
    if (error) throw error;
    if (data?.length !== 1) throw new Error("未保存，请检查权限或刷新列表后重试。");
    showStatus(rStatus, editingResume !== null ? "履历修改成功！" : "履历已上传成功！", "success");
    resetResumeForm();
    await loadResumes();
  } catch (error) {
    showStatus(rStatus, "保存失败：" + error.message, "error");
  } finally {
    btn.disabled = false;
  }
});

function resetResumeForm() {
  editingResume = null;
  resumeForm.reset();
  rTbody.innerHTML = "";
  addResumeRow();
  document.getElementById("r_form_title").textContent = "上传我的履历";
  resumeForm.querySelector('button[type="submit"]').textContent = "提交履历";
  document.getElementById("r_cancel_edit").hidden = true;
}
document.getElementById("r_cancel_edit").addEventListener("click", resetResumeForm);

/* ========= 履历统计 - 列表 ========= */
function resumeRoleTag(role) {
  return `<span class="tag">${escapeHtml(role)}</span>`;
}

async function loadResumes() {
  const { data, error } = await sbClient
    .from("resumes")
    .select("id, grade, name, records, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    resumeLoadState = "error";
    updateHomeStats();
    rList.innerHTML = '<div class="empty-row">加载失败，请检查网络。</div>';
    console.error(error);
    return;
  }

  resumeData = data || [];
  resumeLoadState = "ready";
  renderResumes(resumeData);
}

function renderResumes(data) {
  updateHomeStats();
  rCount.textContent = "共 " + data.length + " 条";

  if (!data || data.length === 0) {
    rList.innerHTML =
      '<div class="resume-empty">暂无履历记录，登录后可添加。</div>';
    return;
  }

  rList.innerHTML = data
    .map((r) => {
      const records = Array.isArray(r.records) ? r.records : [];
      const rows = records
        .map(
          (rc, i) => `
        <tr>
          <td style="width:50px">${i + 1}</td>
          <td>${escapeHtml(rc.tournament || "")}</td>
          <td style="width:180px">${resumeRoleTag(rc.role || "")}</td>
        </tr>
      `
        )
        .join("");

      return `
      <div class="resume-card">
        <div class="resume-header">
          <div class="resume-info">
            <span class="grade">${escapeHtml(r.grade)}级</span>
            <span class="name">${escapeHtml(r.name)}</span>
            <span class="time">上传时间：${formatDate(r.created_at)}</span>
          </div>
          <div class="resume-actions">
            <span class="count">共 ${records.length} 条记录</span>
            ${canWrite ? `<button type="button" class="btn-outline" data-edit-id="${r.id}">修改履历</button><button type="button" class="btn-danger" data-delete-id="${r.id}">删除履历</button>` : ""}
          </div>
        </div>
        <div class="resume-records">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:50px">#</th>
                  <th>赛事名称</th>
                  <th style="width:180px">履历情况</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="3" class="empty-row">无记录</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    })
    .join("");
}

/* ========= 初始化 ========= */
addMatchRow();
addResumeRow();
loadTournaments();
loadResumes();
refreshPermissions();
