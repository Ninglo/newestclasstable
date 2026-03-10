export const appTemplate = `
  <div class="overlay" id="overlay"></div>

  <section class="home-view" id="homeView">
    <header class="home-header">
      <div class="welcome-box" id="welcomeBox" title="右键可修改用户名">
        <h1 id="welcomeText">Welcome!</h1>
        <p id="todayText">今天是</p>
      </div>
      <div class="theme-switch">
        <label for="themeSelect">主题</label>
        <select id="themeSelect">
          <option value="classic">经典蓝</option>
          <option value="sky">天空贴纸</option>
          <option value="sunny">阳光卡通</option>
        </select>
      </div>
    </header>

    <section class="home-actions">
      <button class="primary" id="generateWeekBtn" onclick="generateWeeklySeating()">生成第<span id="homeWeekNum">1</span>周座位表</button>
      <button id="newClassBtn" onclick="showCreateClassDialog()">新建班级座位表</button>
    </section>

    <section class="class-overview">
      <h2>班级总览</h2>
      <div id="homeClassList" class="home-class-list"></div>
    </section>
  </section>

  <section class="editor-view hidden" id="editorView">
    <div class="editor-stage">
      <button class="back-home" onclick="goHome()">返回主页</button>

      <div class="class-selector">
        <select id="classSelect" onchange="loadClass()">
          <option value="">选择班级...</option>
        </select>
        <div class="time-toggle">
          <button onclick="toggleTime('weekday')" id="weekdayBtn" class="active">周中</button>
          <button onclick="toggleTime('weekend')" id="weekendBtn">周末</button>
        </div>
        <button class="delete-btn" onclick="deleteCurrentClass()">删除</button>
      </div>

      <div class="main-content">
        <div class="left-section">
          <div class="header">
            <input type="text" id="headerClassName" value="J328" placeholder="XXXX" maxlength="8" />班座位表
          </div>
          <div class="info-section">
            <div class="time-display">
              <span class="emoji">⏰</span>
              <input type="text" class="info-input" id="date" placeholder="月" />月
              <input type="text" class="info-input" id="day" placeholder="日" />日
              <select class="weekday-select" id="weekday">
                <option value="">选择星期</option>
                <option value="星期一">星期一</option>
                <option value="星期二">星期二</option>
                <option value="星期三">星期三</option>
                <option value="星期四">星期四</option>
                <option value="星期五">星期五</option>
                <option value="星期六">星期六</option>
                <option value="星期日">星期日</option>
              </select>
              <input type="text" class="info-input wider" id="time" placeholder="时间" />
            </div>
            <div class="location-display">
              <span class="emoji">🏫</span>
              <select class="campus-select" id="campus">
                <option value="">选择校区</option>
                <option value="C86校区">C86校区</option>
                <option value="七彩校区">七彩校区</option>
              </select>
              <input type="text" class="info-input" id="floor" placeholder="楼" />楼
              <input type="text" class="info-input wider" id="room" placeholder="教室" />
            </div>
          </div>
          <div class="screen-banner">屏幕 & 白板</div>
          <div class="classroom" id="classroom"></div>
        </div>

        <div class="right-section">
          <div class="notes-section">
            <div class="notes-toolbar">
              <select id="noteFontSize">
                <option value="12">12px</option>
                <option value="14">14px</option>
                <option value="16" selected>16px</option>
                <option value="18">18px</option>
                <option value="20">20px</option>
                <option value="24">24px</option>
              </select>
              <input type="color" id="noteColor" value="#000000" />
              <div class="text-align-group">
                <button onclick="setTextAlign('left')" title="左对齐"><i>⬅️</i></button>
                <button onclick="setTextAlign('center')" title="居中对齐"><i>⬆️</i></button>
                <button onclick="setTextAlign('right')" title="右对齐"><i>➡️</i></button>
              </div>
              <div class="text-align-group">
                <button onclick="setVerticalAlign('top')" title="顶部对齐"><i>⬆️</i></button>
                <button onclick="setVerticalAlign('middle')" title="垂直居中"><i>↕️</i></button>
                <button onclick="setVerticalAlign('bottom')" title="底部对齐"><i>⬇️</i></button>
              </div>
            </div>
            <div class="notes-content" id="notes" contenteditable="true" placeholder="在此添加备注内容..."></div>
          </div>
        </div>
      </div>
    </div>

    <button class="save-button" onclick="showSaveDialog()">保存配置</button>
    <div class="controls">
      <button onclick="showBatchImportDialog()">批量导入</button>
      <button onclick="showImportDialog()">文字导入</button>
      <button onclick="showImageImportDialog()">图片导入</button>
      <button onclick="showManualTuneDialog()">手动微调</button>
      <div class="edit-mode">
        <button onclick="toggleEditMode()">编辑模式</button>
      </div>
      <button onclick="toggleLayout()">切换布局</button>
      <button onclick="generateSeating()">下一次轮换</button>
    </div>
  </section>

  <div class="save-dialog dialog" id="saveDialog">
    <h2>保存班级配置</h2>
    <input type="text" id="saveClassName" placeholder="输入班级名称" />
    <div class="buttons">
      <button class="cancel" onclick="hideSaveDialog()">取消</button>
      <button class="confirm" onclick="saveClass()">保存</button>
    </div>
  </div>

  <div class="dialog" id="createClassDialog">
    <h2>新建班级座位表</h2>
    <div class="create-options">
      <button onclick="showImageImportDialog()">1. 原有座位表图片导入</button>
      <button onclick="showImportDialog()">2. 文字导入</button>
      <button disabled>3. 教务系统导入（开发中）</button>
    </div>
    <div class="buttons">
      <button class="cancel" onclick="hideCreateClassDialog()">关闭</button>
    </div>
  </div>

  <div class="dialog import-dialog" id="importDialog">
    <h2>导入学生名单</h2>
    <div class="layout-selector">
      <label>选择教室布局：</label>
      <div class="layout-option">
        <input type="radio" name="layout" value="circular" id="circularLayout" checked />
        <label for="circularLayout">六张圆桌布局</label>
      </div>
      <div class="layout-option">
        <input type="radio" name="layout" value="rows" id="rowsLayout" />
        <label for="rowsLayout">三横排布局</label>
      </div>
      <div class="layout-option">
        <input type="radio" name="layout" value="arc" id="arcLayout" />
        <label for="arcLayout">圆弧布局（两横排）</label>
      </div>
    </div>
    <p>请输入学生名单（每行一个名字）：</p>
    <div id="layoutDescription">
      <ul style="font-size: 14px; color: #666; margin: 10px 0;">
        <li>圆桌：31-36人=6组，25-30人=5组，19-24人=4组，1-18人=3组</li>
        <li>三横排：31-36人=6组，25-30人=5组，1-24人=4组</li>
        <li>圆弧：两排布局，最多36人</li>
      </ul>
    </div>
    <textarea id="studentNames" placeholder="请输入学生名字，每行一个..."></textarea>
    <div id="errorMsg"></div>
    <div class="buttons">
      <button class="cancel" onclick="hideImportDialog()">取消</button>
      <button class="confirm" onclick="importStudents()">确认导入</button>
    </div>
  </div>

  <div class="dialog" id="imageImportDialog">
    <h2>图片识别导入</h2>
    <p>支持单图单班级与多图多班级，识别后可人工修改再导入。</p>
    <div class="ocr-config-grid">
      <label>识别引擎
        <select id="ocrEngine">
          <option value="hybrid">腾讯优先（默认不回退）</option>
          <option value="tencent">仅腾讯 OCR</option>
          <option value="local">仅本地 OCR</option>
        </select>
      </label>
      <label class="ocr-checkbox">
        <input type="checkbox" id="allowLocalFallback" />
        <span>腾讯失败时回退本地OCR（默认关闭）</span>
      </label>
      <label>腾讯代理地址
        <input id="tencentEndpoint" placeholder="http://127.0.0.1:8787" />
      </label>
      <div id="ocrCloudConfig" class="ocr-cloud-config">
        <label>腾讯地域
          <input id="tencentRegion" placeholder="ap-guangzhou" />
        </label>
        <label>腾讯接口
          <select id="tencentAction">
            <option value="Auto">自动（优先最新AI接口）</option>
            <option value="ExtractDocMulti">ExtractDocMulti（最新AI）</option>
            <option value="GeneralAccurateOCR">GeneralAccurateOCR</option>
            <option value="GeneralBasicOCR">GeneralBasicOCR</option>
          </select>
        </label>
      </div>
      <div class="ocr-check-row">
        <button type="button" onclick="checkOCRChannel()">检测OCR通道</button>
        <div id="ocrEngineStatus" class="muted">点击“检测OCR通道”可验证当前是否走腾讯AI接口。</div>
      </div>
      <div class="ocr-hint">提示：先启动本地代理 npm run ocr:proxy，再点击“开始识别”。</div>
    </div>
    <input type="file" id="imageFiles" accept="image/*" multiple />
    <div id="ocrProgress" class="progress"></div>
    <div id="ocrReviewList" class="ocr-review-list"></div>
    <div class="buttons">
      <button class="cancel" onclick="hideImageImportDialog()">取消</button>
      <button onclick="startImageRecognition()">开始识别</button>
      <button class="confirm" onclick="confirmImageImport()">确认导入</button>
    </div>
  </div>

  <div class="dialog" id="manualTuneDialog">
    <h2>手动微调</h2>
    <p>设置当前布局小组数量并自动重新均分学生</p>
    <div class="manual-row">
      <label for="manualGroupCount">组数</label>
      <input type="number" id="manualGroupCount" min="1" max="6" value="6" />
    </div>
    <div id="manualTuneError" class="error"></div>
    <div class="buttons">
      <button class="cancel" onclick="hideManualTuneDialog()">取消</button>
      <button class="confirm" onclick="applyManualTune()">应用</button>
    </div>
  </div>

  <div class="dialog batch-import-dialog" id="batchImportDialog">
    <h2>批量导入班级配置</h2>
    <p>请按照以下格式输入数据（使用!作为班级分隔符）：</p>
    <div class="format-example">班级名称: J328
校区: C86校区
楼层: 1
教室: 101

周中布局: 圆桌
周中时间:
月: 3
日: 7
星期: 星期六
时间: 11:20-12:20

Group 1: Jenny, Andy, Rain
Group 2: Bella, Sunny, David
!
班级名称: J329
周中布局: 三排
Group 1: Amy, Lucas</div>
    <textarea id="batchImportData" placeholder="在此输入数据..."></textarea>
    <div id="batchImportError" class="error"></div>
    <div class="buttons">
      <button class="cancel" onclick="hideBatchImportDialog()">取消</button>
      <button class="confirm" onclick="processBatchImport()">确认导入</button>
    </div>
  </div>
`;
