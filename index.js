// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, writeExtensionField, renderExtensionTemplateAsync, getApiUrl, doExtrasFetch } from "../../../extensions.js";

//You'll likely need to import some other functions from the main script
import * as script from "../../../../script.js";

import { debounce, delay } from "../../../../scripts/utils.js";

import { playMessageSound } from '../../../../scripts/power-user.js';

import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../../slash-commands/SlashCommandScope.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import * as commands from '../../../slash-commands.js';

// Keep track of where your extension is located, name should match repo name
const extensionName = "SillyTavernExtension-JsRunner";
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;
const templatePath = `third-party/${extensionName}`
const defaultSettings = {};

 
// Loads the extension settings if they exist, otherwise initializes them to the defaults.
async function loadSettings() {
  if ($('#jed').length == 0) {
    $('body').append('<link href="' + extensionFolderPath + '/3rd/css/jsoneditor.min.css" rel="stylesheet">');
    $('body').append('<script id="jed" src="' + extensionFolderPath + '/3rd/js/jsoneditor.min.js"></script>');
  }

  if ($('#ace').length == 0) {
    $('body').append('<script id="ace" src="' + extensionFolderPath + '/3rd/js/ace/ace.js"></script>');
    $('body').append('<script src="' + extensionFolderPath + '/3rd/js/ace/ext-language_tools.js"></script>');
  }

  $(".runner-extension-settings .runner-extension_block").empty();
  //Create the settings if they don't exist
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }

  // Updating settings in the UI
  const javascripts = extension_settings[extensionName].javascripts
  if (javascripts) {
    for (const index in javascripts) {
      const j = javascripts[index]
      const blockHtml = $(await renderExtensionTemplateAsync(templatePath, 'block'));
      blockHtml.find(".runner_script_name").text(' ❖ ' + javascripts[index].name);
      if (!j.enabled) {
        blockHtml.find(".enabled_button i").removeClass("fa-toggle-on");
        blockHtml.find(".enabled_button i").addClass("fa-toggle-off");
      }
      blockHtml.attr("id", "runner-script_block-" + index)
      $(".runner-extension-settings .runner-extension_block").append(blockHtml);

      blockHtml.find(".enabled_button").on("click", async () => {
        extension_settings[extensionName].javascripts[index].enabled = !j.enabled;
        script.saveSettingsDebounced();
        await loadSettings();
      });
      blockHtml.find(".edit_button").on("click", async () => {
        onEditButtonClick(index, j)
      });
      blockHtml.find(".del_button").on("click", async () => {
        extension_settings[extensionName].javascripts.splice(index, 1);
        script.saveSettingsDebounced();
        await loadSettings();
      });

      if (j.enabled) {
        await javascriptEval(blockHtml, j.name, j.javascript)
      }
    }
  }
}

// This function is called when the button is clicked
async function onAddButtonClick() {
  let codeEditor = () => {
    $('.editor_maximize').on('click', function () {
      setTimeout(initCodeEditor, 100);
    });
  }
  // You can do whatever you want here
  // Let's make a popup appear with the checked setting
  const editorHtml = $(await renderExtensionTemplateAsync(templatePath, 'edit'));
  script.callPopup(editorHtml, 'confirm', undefined, { okButton: 'Save' }).then(popupResult => {
    if (popupResult) {
      extension_settings[extensionName].javascripts = extension_settings[extensionName].javascripts || [];
      extension_settings[extensionName].javascripts.push({
          enabled: true,
          name: editorHtml.find('.runner_script_name').val(),
          javascript: editorHtml.find('.runner_script_value').val(),
      })
      toastr.info("add success!");
      script.saveSettingsDebounced();
      loadSettings();
    }
  });
  codeEditor();
}

async function onEditButtonClick(index, data) {
  let codeEditor = () => {
    $('.editor_maximize').on('click', function () {
      setTimeout(initCodeEditor, 100);
    });
  }
  // You can do whatever you want here
  // Let's make a popup appear with the checked setting
  const editorHtml = $(await renderExtensionTemplateAsync(templatePath, 'edit'));
  editorHtml.find('.runner_script_name').val(data.name);
  editorHtml.find('.runner_script_value').val(data.javascript);
  script.callPopup(editorHtml, 'confirm', undefined, { okButton: 'Save' }).then(popupResult => {
    if (popupResult) {
      extension_settings[extensionName].javascripts = extension_settings[extensionName].javascripts || [];
      data = {...data,
        name: editorHtml.find('.runner_script_name').val(),
        javascript: editorHtml.find('.runner_script_value').val(),
      }
      extension_settings[extensionName].javascripts[index] = data;
      toastr.info("edit success!");
      script.saveSettingsDebounced();
      loadSettings();
    }
  });
  codeEditor();
}

// ===================== 文件导入（新增功能，上方原有逻辑未改动）=====================
// 原来只有 add -> 手动粘贴，几百行的脚本贴进去容易截断然后爆红。
// 这里允许直接选文件：.txt / .js 整个文件作为一条脚本；.json 按下面的几种形状解析。

const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function importFileStem(name) {
  const base = String(name).replace(/^.*[\\/]/, "");
  return base.replace(/\.[^.]+$/, "") || base;
}

function importCountLines(text) {
  return text ? text.split("\n").length : 0;
}

function importUniqueName(list, wanted) {
  const taken = new Set(list.filter(x => x && typeof x === "object").map(x => String(x.name ?? "")));
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted} (${n})`)) n++;
  return `${wanted} (${n})`;
}

// 认这四种：[{name,javascript}]、{javascripts:[...]}、{name,javascript}、["源码", ...]
function importPickFromJson(data) {
  const usable = [];
  const push = (item, fallbackName) => {
    if (item && typeof item === "object" && typeof item.javascript === "string") {
      usable.push({
        name: String(item.name ?? fallbackName ?? ""),
        javascript: item.javascript,
        enabled: item.enabled !== false,
      });
    } else if (typeof item === "string" && item.trim()) {
      usable.push({ name: String(fallbackName ?? ""), javascript: item, enabled: true });
    }
  };

  if (Array.isArray(data)) {
    data.forEach(item => push(item));
    return usable;
  }
  if (data && typeof data === "object") {
    if (Array.isArray(data.javascripts)) {
      data.javascripts.forEach(item => push(item));
      return usable;
    }
    push(data);
    return usable;
  }
  return usable;
}

function importEntriesFromFile(fileName, text) {
  const ext = (String(fileName).match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const stem = importFileStem(fileName);

  if (!text.trim()) return { error: "文件内容为空" };

  if (ext === "json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { error: `JSON 解析失败：${e.message}` };
    }
    const picked = importPickFromJson(parsed);
    if (!picked.length) {
      return { error: "不是可识别的脚本 JSON（需要 javascript 或 javascripts 字段）" };
    }
    return { entries: picked.map(p => ({ ...p, name: p.name || stem })) };
  }

  return { entries: [{ name: stem, javascript: text, enabled: true }] };
}

async function onImportFilesChosen(event) {
  const files = Array.from(event.target.files || []);
  // 先清空，保证连续选同一个文件也能再次触发 change
  event.target.value = "";
  if (!files.length) return;

  extension_settings[extensionName].javascripts = extension_settings[extensionName].javascripts || [];
  const list = extension_settings[extensionName].javascripts;

  const done = [];
  const skipped = [];

  for (const file of files) {
    if (file.size > IMPORT_MAX_BYTES) {
      skipped.push(`${file.name}：${(file.size / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限`);
      continue;
    }

    let text;
    try {
      text = await file.text();
    } catch (e) {
      skipped.push(`${file.name}：读取失败 ${e.message}`);
      continue;
    }

    const result = importEntriesFromFile(file.name, text);
    if (result.error) {
      skipped.push(`${file.name}：${result.error}`);
      continue;
    }

    for (const entry of result.entries) {
      const name = importUniqueName(list, entry.name || "未命名脚本");
      list.push({ enabled: entry.enabled !== false, name, javascript: entry.javascript });
      done.push(`${name}（${file.size} 字节 / ${importCountLines(text)} 行）`);
    }
  }

  if (done.length) {
    script.saveSettingsDebounced();
    // 与 add 保存后的行为一致：启用状态的脚本会立即执行
    await loadSettings();
    toastr.success(`已导入 ${done.length} 条：${done.join("、")}`);
  }
  if (skipped.length) {
    toastr.error(`${skipped.length} 个文件未导入：${skipped.join("；")}`);
  }
  console.info("[JsRunner] 导入成功:", done, "未导入:", skipped);
}
// ===============================================================================

async function javascriptEval(blockHtml, name, javascript) {
    const setting = () => {
      blockHtml.find('.setting_button').removeClass('disabled')
      return {
        on: (functionCall) => {
          blockHtml.find('.setting_button').on('click', functionCall)
        }
      }
    }

    try {
        const extensions = {
            getContext, toastr, doExtrasFetch, getApiUrl, debounce, delay, setting, initCodeEditor, initJsonEditor,
            writeExtensionField, playMessageSound,
        }
        const command = {
            ARGUMENT_TYPE, 
            SlashCommandParser, SlashCommandScope,
            SlashCommandArgument, SlashCommandNamedArgument, SlashCommand,
            ...commands,
        }

        // 事件代码需考虑注册事件和注销事件的处理！
        Function("script, extensions, command", `with(script, extensions, command) { ${javascript} }`)
            .bind(window)(script, extensions, command)
    } catch(e) {
        console.error(e)
        toastr.error(`exec "${name}" error! check the exception information on the console.`);
    }
}

async function initJsonEditor() {
  const textarea = $('dialog[class^=popup] .popup-content > div > textarea');
  const content = textarea.val() ?? '{}';
  textarea.css('display', 'none');
  $('body').addClass('noShadows-1');

  $('dialog[class^=popup] .popup-content > div').append('<div id="jsonEditor" class="height100p wide100p"></div>');
  const options = {
    onChangeJSON: (data) => {
      textarea.val(JSON.stringify(data, null, 4));
      textarea[0].dispatchEvent(new Event('input'));
    },
  }
  const editor = new JSONEditor(document.querySelector('#jsonEditor'), options);
  $(editor.menu).find('.jsoneditor-sort').hide();
  $(editor.menu).find('.jsoneditor-transform').hide();
  editor.set(JSON.parse(content));
  $('dialog[class^=popup] .popup-body .popup-button-ok').on('click', () => {
    $('body').removeClass('noShadows-1');
  });
}

async function initCodeEditor(language = "javascript", theme = "tomorrow_night") {
  const textarea = $('dialog[class^=popup] .popup-content > div > textarea');
  const content = textarea.val();
  // textarea.css('display', 'none');

  $('dialog[class^=popup] .popup-content > div').attr('id', 'codeEditor');

  //获取控件   id ：codeEditor
  const editor = ace.edit("codeEditor");
  //主题
  editor.setTheme("ace/theme/" + theme);
  //语言
  editor.session.setMode("ace/mode/" + language);
  //字体大小
  editor.setFontSize(15);
  //设置只读（true时只读，用于展示代码）
  editor.setReadOnly(false);
  //自动换行,设置为off关闭
  editor.setOption("wrap", "free");
  //启用提示菜单
  ace.require("ace/ext/language_tools");
  editor.setOptions({
      enableBasicAutocompletion: true,
      enableSnippets: true,
      enableLiveAutocompletion: true,
  });

  editor.setValue(content);
  editor.on('change', () => {
    textarea.val(editor.getValue());
    textarea[0].dispatchEvent(new Event('input'));
  });
}

// ===================== 重启后脚本失效的修复（新增，上方原有逻辑未改动）=====================
// 关掉酒馆再进来，脚本改写出请求的钩子没注册上 -> penalty 原样发出 -> API 报 400，
// 手工把开关拨一下才恢复。能造成这个现象的三处一起兜：
//   1) 存盘走 debounce，改完立刻关窗口就来不及写盘；
//   2) 启动那趟渲染循环中途抛错，排在后面的脚本连执行的机会都没有；
//   3) 扩展加载早于酒馆初始化，脚本注册事件时它依赖的东西还没就绪。

const runnerRanOk = new Set();

function runnerHash(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}

function runnerKey(name, javascript) {
  return String(name) + '::' + runnerHash(javascript);
}

function runnerIsReady() {
  return document.readyState === 'complete';
}

// 与原来 javascriptEval 里那两份构造保持一字不差，只是抽出来好复用
function runnerBuildExtensions(blockHtml) {
  const setting = () => {
    blockHtml.find('.setting_button').removeClass('disabled');
    return {
      on: (functionCall) => {
        blockHtml.find('.setting_button').on('click', functionCall);
      }
    };
  };
  return {
    getContext, toastr, doExtrasFetch, getApiUrl, debounce, delay, setting, initCodeEditor, initJsonEditor,
    writeExtensionField, playMessageSound,
  };
}

function runnerBuildCommand() {
  return {
    ARGUMENT_TYPE,
    SlashCommandParser, SlashCommandScope,
    SlashCommandArgument, SlashCommandNamedArgument, SlashCommand,
    ...commands,
  };
}

// 成没成功要能知道，所以不复用上面那个把异常吞掉的 javascriptEval；quiet 时不再弹第二条 toast
async function runnerEvalOnce(blockHtml, name, javascript, quiet) {
  try {
    Function("script, extensions, command", `with(script, extensions, command) { ${javascript} }`)
      .bind(window)(script, runnerBuildExtensions(blockHtml), runnerBuildCommand());
    return true;
  } catch (e) {
    console.error(e);
    if (!quiet) toastr.error(`exec "${name}" error! check the exception information on the console.`);
    return false;
  }
}

// 覆盖同名原函数：同一份正文一次会话只许执行一遍，避免事件重复注册
javascriptEval = async function (blockHtml, name, javascript) {
  const key = runnerKey(name, javascript);
  if (runnerRanOk.has(key)) return false;
  if (await runnerEvalOnce(blockHtml, name, javascript)) {
    runnerRanOk.add(key);
    return true;
  }
  return false;
};

function runnerForceSave() {
  try {
    if (typeof script.saveSettings === 'function') script.saveSettings();
    else script.saveSettingsDebounced();
  } catch (e) {
    console.error('[JsRunner] force save failed', e);
  }
}

// 把渲染循环没带到、以及启动太早失败的脚本补跑一遍（只跑没成功的，不会重复注册）
async function runnerSweep() {
  const list = ((extension_settings || {})[extensionName] || {}).javascripts || [];
  const pending = list.filter(item => item && item.enabled && item.javascript &&
    !runnerRanOk.has(runnerKey(item.name, item.javascript)));
  if (!pending.length) return 0;

  // 先借一次真正的渲染，被救回来的脚本才能拿到自己的 blockHtml（extensions.setting() 要往齿轮上绑）
  try { await loadSettings(); } catch (e) { console.error(e); }

  let fixed = 0;
  const done = new Set();
  for (const item of pending) {
    const key = runnerKey(item.name, item.javascript);
    if (runnerRanOk.has(key)) {
      if (!done.has(key)) { done.add(key); fixed++; }
      continue;
    }
    // 上面那趟还是没带上它（多半是渲染中途抛错），退化成游离节点补跑
    const orphan = $('<div class="runner-script_block"></div>');
    if (await runnerEvalOnce(orphan, item.name, item.javascript, true)) {
      runnerRanOk.add(key);
      fixed++;
    }
  }
  if (fixed) console.info('[JsRunner] 补执行了 ' + fixed + ' 条脚本');
  return fixed;
}

function runnerInstall() {
  window.addEventListener('pagehide', runnerForceSave);
  window.addEventListener('beforeunload', runnerForceSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') runnerForceSave();
  });

  // 有限三次，跑完就停；成功的会被 runnerRanOk 挡住，不会叠加
  const later = () => [0, 1500, 5000].forEach(ms =>
    setTimeout(() => runnerSweep().catch(e => console.error(e)), ms));
  if (runnerIsReady()) later();
  else window.addEventListener('load', later, { once: true });
}

runnerInstall();
// ===============================================================================

// This function is called when the extension is loaded
jQuery(async () => {
  // This is an example of loading HTML from a file
  const settingsHtml = $(await renderExtensionTemplateAsync(templatePath, 'panel'));

  // Append settingsHtml to extensions_settings
  // extension_settings and extensions_settings2 are the left and right columns of the settings menu
  // Left should be extensions that deal with system functions and right should be visual/UI related 
  $("#extensions_settings").append(settingsHtml);

  // These are examples of listening for events
  $("#add_button").on("click", onAddButtonClick);

  // 文件导入：按钮触发隐藏的文件选择框，选完交给 onImportFilesChosen
  $("#import_button").on("click", () => $("#runner_import_input").trigger("click"));
  $("#runner_import_input").on("change", onImportFilesChosen);

  // Load settings when starting things up (if you have any)
  loadSettings();
});
