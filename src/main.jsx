import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlarmClock,
  Award,
  BarChart3,
  BellRing,
  BookOpenCheck,
  CalendarDays,
  Camera,
  CheckCircle2,
  Clock3,
  Edit3,
  HelpCircle,
  LogOut,
  Heart,
  Flame,
  Gauge,
  GraduationCap,
  LayoutDashboard,
  Medal,
  MessageCircle,
  MessageSquarePlus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  UserPlus,
  Video,
  UsersRound,
  X
} from "lucide-react";
import "./styles.css";

const REMINDER_ID_BASE = 20_000;

const defaultGoal = {
  subject: "Toán 11",
  target: "Nắm chắc hàm số và lượng giác để đạt 8+",
  examDate: "2026-06-30",
  level: "Mất gốc một phần",
  hoursPerDay: 2
};

const seedTasks = [
  { day: "Hôm nay", block: "19:30", title: "Ôn lý thuyết hàm số", mode: "Học sâu", minutes: 45, done: true },
  { day: "Hôm nay", block: "20:15", title: "20 câu lượng giác cơ bản", mode: "Luyện tập", minutes: 60, done: false },
  { day: "Ngày mai", block: "19:45", title: "Sửa lỗi sai và ghi nhật ký", mode: "Phản tư", minutes: 35, done: false },
  { day: "Thứ 7", block: "08:30", title: "Mini test theo deadline", mode: "Kiểm tra", minutes: 75, done: false }
];

const apps = [
  { name: "YouTube", minutes: 48, effect: "Cần kiểm soát", type: "Giải trí" },
  { name: "Quizlet", minutes: 36, effect: "Hỗ trợ học", type: "Học tập" },
  { name: "TikTok", minutes: 31, effect: "Lệch mục tiêu", type: "Giải trí" },
  { name: "Google Docs", minutes: 22, effect: "Hỗ trợ học", type: "Học tập" }
];

const groups = [
  { name: "Lớp Toán bứt tốc", members: 18, streak: 9, rank: 2 },
  { name: "Ôn thi THPT tự học", members: 42, streak: 14, rank: 5 },
  { name: "Vật lý mỗi ngày", members: 12, streak: 6, rank: 1 }
];

const seedPosts = [
  {
    id: 1,
    author: "Minh Anh",
    badge: "Chuỗi 9 ngày",
    type: "Điểm số",
    content: "Vừa kéo bài kiểm tra Toán từ 6.5 lên 8.2 sau 2 tuần theo lịch AI.",
    proof: "Bảng điểm",
    image: "",
    studyMinutes: 1260,
    likes: 34,
    comments: 8,
    liked: false
  },
  {
    id: 2,
    author: "Quang Huy",
    badge: "Học sâu",
    type: "Kỷ luật",
    content: "Hoàn thành 4 phiên pomodoro 45 phút, không mở TikTok trong giờ học.",
    proof: "Timelapse",
    image: "",
    studyMinutes: 180,
    likes: 21,
    comments: 5,
    liked: false
  }
];

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "";
const aiRequestSecret = import.meta.env.VITE_AI_REQUEST_SECRET || "";
function App() {
  const [active, setActive] = useState("dashboard");
  const [tabHistory, setTabHistory] = useState(["dashboard"]);
  const [authUser, setAuthUser] = useState(() => load("authUser", null));
  const [users, setUsers] = useState(() => load("users", []));
  const [goal, setGoal] = useState(() => load("goal", defaultGoal));
  const [tasks, setTasks] = useState(() => load("tasks", seedTasks));
  const [minutes, setMinutes] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [deviceApps, setDeviceApps] = useState(apps);
  const [usageStatus, setUsageStatus] = useState({
    source: "mock",
    message: "Đang dùng dữ liệu mẫu."
  });
  const [reminderStatus, setReminderStatus] = useState({
    source: "idle",
    message: "Chưa bật nhắc lịch học."
  });
  const [proofs, setProofs] = useState(() => load("proofs", 7));
  const [aiPlan, setAiPlan] = useState(() => load("aiPlan", null));
  const [tutorMessages, setTutorMessages] = useState(() => load("tutorMessages", [
    {
      role: "assistant",
      content: "Mình là gia sư AI của bạn. Gửi bài tập, câu hỏi hoặc phần đang kẹt, mình sẽ gợi ý từng bước."
    }
  ]));
  const [posts, setPosts] = useState(() => load("posts", seedPosts));
  const [timelapses, setTimelapses] = useState(() => load("timelapses", []));
  const [studyGroups, setStudyGroups] = useState(() => load("studyGroups", groups));
  const [mistakes, setMistakes] = useState(() => load("mistakes", []));
  const [aiStatus, setAiStatus] = useState("idle");
  const [aiError, setAiError] = useState("");
  const [tutorStatus, setTutorStatus] = useState("idle");
  const [tutorError, setTutorError] = useState("");
  const [mistakeStatus, setMistakeStatus] = useState("idle");
  const [mistakeError, setMistakeError] = useState("");
  const [socialStatus, setSocialStatus] = useState("local");
  const [studySyncStatus, setStudySyncStatus] = useState("local");
  const [apiHealth, setApiHealth] = useState({ status: "checking", message: "Dang kiem tra server AI..." });
  const lastSyncedGoal = useRef("");
  const lastSyncedTasks = useRef("");
  const webReminderTimers = useRef([]);
  const serverUserId = authUser?.source === "server" ? authUser.id : null;

  const navigateTo = useCallback((nextTab) => {
    setActive((currentTab) => {
      if (currentTab === nextTab) return currentTab;
      setTabHistory((history) => [...history, nextTab].slice(-12));
      return nextTab;
    });
  }, []);

  const handleAndroidBack = useCallback(async () => {
    let shouldExit = false;

    setTabHistory((history) => {
      if (history.length <= 1) {
        shouldExit = true;
        return history;
      }

      const nextHistory = history.slice(0, -1);
      setActive(nextHistory[nextHistory.length - 1]);
      return nextHistory;
    });

    if (shouldExit) {
      const { App: CapacitorApp } = await import("@capacitor/app");
      CapacitorApp.exitApp();
    }
  }, []);

  useNativeShell(handleAndroidBack);

  useEffect(() => save("authUser", authUser), [authUser]);
  useEffect(() => save("users", users), [users]);
  useEffect(() => save("goal", goal), [goal]);
  useEffect(() => save("tasks", tasks), [tasks]);
  useEffect(() => save("proofs", proofs), [proofs]);
  useEffect(() => save("aiPlan", aiPlan), [aiPlan]);
  useEffect(() => save("tutorMessages", tutorMessages), [tutorMessages]);
  useEffect(() => save("posts", posts), [posts]);
  useEffect(() => save("timelapses", timelapses), [timelapses]);
  useEffect(() => save("studyGroups", studyGroups), [studyGroups]);
  useEffect(() => save("mistakes", mistakes), [mistakes]);
  useEffect(() => () => {
    webReminderTimers.current.forEach((timer) => window.clearTimeout(timer));
    webReminderTimers.current = [];
  }, []);

  useEffect(() => {
    if (!serverUserId) {
      setStudySyncStatus("local");
      return;
    }

    let cancelled = false;

    const loadStudyState = async () => {
      try {
        const data = await apiRequest(`/api/users/${serverUserId}/study-state`);
        if (cancelled) return;

        if (data.goal) setGoal(data.goal);
        if (Array.isArray(data.tasks) && data.tasks.length) setTasks(data.tasks);
        if (typeof data.proofs === "number") setProofs(data.proofs);

        lastSyncedGoal.current = JSON.stringify(data.goal || goal);
        lastSyncedTasks.current = JSON.stringify(data.tasks?.length ? data.tasks : tasks);
        setStudySyncStatus("server");
      } catch {
        if (!cancelled) setStudySyncStatus("local");
      }
    };

    loadStudyState();

    return () => {
      cancelled = true;
    };
  }, [serverUserId]);

  useEffect(() => {
    if (!serverUserId) return;

    const serialized = JSON.stringify(goal);
    if (serialized === lastSyncedGoal.current) return;

    const timer = setTimeout(async () => {
      try {
        await apiRequest(`/api/users/${serverUserId}/goal`, {
          method: "PUT",
          body: JSON.stringify({ goal })
        });
        lastSyncedGoal.current = serialized;
        setStudySyncStatus("server");
      } catch {
        setStudySyncStatus("local");
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [goal, serverUserId]);

  useEffect(() => {
    if (!serverUserId) return;

    const serialized = JSON.stringify(tasks);
    if (serialized === lastSyncedTasks.current) return;

    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest(`/api/users/${serverUserId}/tasks`, {
          method: "PUT",
          body: JSON.stringify({ tasks })
        });
        if (Array.isArray(data.tasks)) {
          lastSyncedTasks.current = JSON.stringify(data.tasks);
          setTasks(data.tasks);
        } else {
          lastSyncedTasks.current = serialized;
        }
        setStudySyncStatus("server");
      } catch {
        setStudySyncStatus("local");
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [tasks, serverUserId]);

  useEffect(() => {
    if (!serverUserId) return;

    const timer = setTimeout(async () => {
      try {
        await apiRequest(`/api/users/${serverUserId}/profile`, {
          method: "PUT",
          body: JSON.stringify({ proofs })
        });
        setStudySyncStatus("server");
      } catch {
        setStudySyncStatus("local");
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [proofs, serverUserId]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setMinutes((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    let cancelled = false;

    const checkApi = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`, { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;

        setApiHealth({
          status: response.ok ? "online" : "error",
          message: response.ok
            ? `Server AI online: ${data.model || "Gemini"}`
            : `Server tra loi ${response.status}`
        });
      } catch {
        if (!cancelled) {
          setApiHealth({
            status: "offline",
            message: `Khong ket noi duoc server AI tai ${apiBaseUrl || "cung host"}`
          });
        }
      }
    };

    checkApi();
    const timer = setInterval(checkApi, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const refreshUsageStats = useCallback(async () => {
    try {
      const { Capacitor, registerPlugin } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) {
        setUsageStatus({ source: "mock", message: "Bản web dùng dữ liệu mẫu; APK Android mới đọc được usage thật." });
        return;
      }

      const UsageStats = registerPlugin("UsageStats");
      const permission = await UsageStats.hasPermission();

      if (!permission.granted) {
        setUsageStatus({ source: "permission", message: "Cần cấp quyền Usage Access để đọc thời gian dùng app thật." });
        setDeviceApps(apps);
        return;
      }

      const result = await UsageStats.getUsageStats({ days: 1 });
      const nextApps = Array.isArray(result.apps) ? result.apps : [];
      setDeviceApps(nextApps);

      if (!nextApps.length) {
        setUsageStatus({ source: "real", message: "Đã có quyền Usage Access, nhưng Android chưa trả về dữ liệu trong 24 giờ gần đây. Hãy dùng vài app rồi bấm cập nhật lại." });
        return;
      }

      setUsageStatus({
        source: "real",
        message: `Đang hiển thị usage thật trong 24 giờ gần đây: ${result.totalApps || nextApps.length} app.`
      });
    } catch (error) {
      setUsageStatus({ source: "mock", message: error.message || "Chưa đọc được usage thật, đang dùng dữ liệu mẫu." });
      setDeviceApps(apps);
    }
  }, []);

  const openUsageSettings = useCallback(async () => {
    try {
      const { Capacitor, registerPlugin } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;
      const UsageStats = registerPlugin("UsageStats");
      await UsageStats.openUsageSettings();
      setUsageStatus({ source: "permission", message: "Sau khi bật Study Compass trong Usage Access, quay lại app và bấm cập nhật." });
    } catch {
      setUsageStatus({ source: "mock", message: "Không mở được màn hình cấp quyền usage." });
    }
  }, []);

  const scheduleStudyReminder = useCallback(async (task, index = 0, options = {}) => {
    const reminderAt = getTaskReminderDate(task);
    const quiet = Boolean(options.quiet);

    if (!reminderAt) {
      if (!quiet) {
        setReminderStatus({
          source: "error",
          message: "Lịch này đã qua hoặc chưa có giờ hợp lệ để nhắc."
        });
      }
      return false;
    }

    const title = `Đến giờ học: ${task.title}`;
    const body = `${task.block} · ${task.mode} · ${task.minutes} phút`;

    try {
      const { Capacitor } = await import("@capacitor/core");

      if (Capacitor.isNativePlatform()) {
        const { LocalNotifications } = await import("@capacitor/local-notifications");
        const permission = await LocalNotifications.requestPermissions();

        if (permission.display !== "granted") {
          if (!quiet) {
            setReminderStatus({
              source: "permission",
              message: "Bạn cần cho phép thông báo để Study Compass nhắc lịch học."
            });
          }
          return false;
        }

        await LocalNotifications.schedule({
          notifications: [
            {
              id: makeReminderId(task, index),
              title,
              body,
              schedule: { at: reminderAt },
              extra: {
                taskTitle: task.title,
                taskBlock: task.block
              }
            }
          ]
        });

        if (!quiet) {
          setReminderStatus({
            source: "native",
            message: `Đã đặt nhắc trực tiếp lúc ${formatReminderTime(reminderAt)}.`
          });
        }
        return true;
      }
    } catch (error) {
      if (!quiet) {
        setReminderStatus({
          source: "error",
          message: error.message || "Chưa đặt được thông báo nhắc học."
        });
      }
      return false;
    }

    if (!("Notification" in window)) {
      if (!quiet) {
        setReminderStatus({
          source: "error",
          message: "Trình duyệt này chưa hỗ trợ thông báo trực tiếp."
        });
      }
      return false;
    }

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      if (!quiet) {
        setReminderStatus({
          source: "permission",
          message: "Bạn cần cho phép thông báo để Study Compass nhắc lịch học."
        });
      }
      return false;
    }

    const delay = reminderAt.getTime() - Date.now();
    if (delay > 2_147_483_647) {
      if (!quiet) {
        setReminderStatus({
          source: "error",
          message: "Lịch này ở quá xa để trình duyệt đặt nhắc tạm thời."
        });
      }
      return false;
    }

    const timer = window.setTimeout(() => {
      new Notification(title, { body });
    }, Math.max(0, delay));
    webReminderTimers.current.push(timer);

    if (!quiet) {
      setReminderStatus({
        source: "web",
        message: `Đã đặt nhắc lúc ${formatReminderTime(reminderAt)} khi app còn mở.`
      });
    }
    return true;
  }, []);

  const scheduleAllStudyReminders = useCallback(async () => {
    const upcomingTasks = tasks
      .map((task, index) => ({ task, index, reminderAt: getTaskReminderDate(task) }))
      .filter((item) => !item.task.done && item.reminderAt)
      .sort((left, right) => left.reminderAt - right.reminderAt)
      .slice(0, 20);

    if (!upcomingTasks.length) {
      setReminderStatus({
        source: "error",
        message: "Chưa có lịch sắp tới để đặt nhắc."
      });
      return;
    }

    let scheduledCount = 0;
    for (const item of upcomingTasks) {
      const ok = await scheduleStudyReminder(item.task, item.index, { quiet: true });
      if (ok) scheduledCount += 1;
    }

    setReminderStatus({
      source: scheduledCount ? "native" : "error",
      message: scheduledCount
        ? `Đã đặt ${scheduledCount} thông báo nhắc học sắp tới.`
        : "Chưa đặt được thông báo nào. Hãy kiểm tra quyền thông báo."
    });
  }, [scheduleStudyReminder, tasks]);

  useEffect(() => {
    if (authUser) refreshUsageStats();
  }, [authUser, refreshUsageStats]);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;

    const loadSocial = async () => {
      try {
        const userQuery = serverUserId ? `?userId=${encodeURIComponent(serverUserId)}` : "";
        const response = await fetch(`${apiBaseUrl}/api/social${userQuery}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Khong tai duoc du lieu cong dong.");
        if (cancelled) return;

        const syncedPosts = await syncLocalOnlyPosts(data.posts || seedPosts, authUser);
        if (cancelled) return;

        setPosts(syncedPosts);
        setStudyGroups(data.groups || groups);
        setSocialStatus("server");
      } catch {
        if (!cancelled) setSocialStatus("local");
      }
    };

    loadSocial();

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  const fallbackPlan = useMemo(() => makePlan(goal), [goal]);
  const plan = aiPlan?.plan?.length ? aiPlan.plan : fallbackPlan;
  const doneCount = tasks.filter((task) => task.done).length;
  const totalStudy = tasks.reduce((sum, task) => sum + (task.done ? task.minutes : 0), 0);
  const streak = calculateStreak(doneCount, totalStudy);

  const generateAiPlan = async () => {
    setAiStatus("loading");
    setAiError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/study-plan`, {
        method: "POST",
        headers: aiHeaders(),
        body: JSON.stringify({ goal })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Không tạo được lộ trình AI.");
      }

      setAiPlan(data);
      setAiStatus("done");
    } catch (error) {
      setAiError(`${error.message || "Không kết nối được AI."} URL: ${apiBaseUrl || "cùng host"}`);
      setAiStatus("error");
    }
  };

  const importAiToday = () => {
    if (!aiPlan?.today?.length) return;

    const nextTasks = aiPlan.today.map((item) => ({
      day: "Hôm nay",
      block: item.time || "20:00",
      title: item.title || "Phiên học AI",
      mode: "Gemini đề xuất",
      minutes: Number(item.minutes || 45),
      done: false
    }));

    setTasks([...nextTasks, ...tasks]);
    navigateTo("schedule");
  };

  const askTutor = async (question) => {
    const cleanQuestion = question.trim();
    if (!cleanQuestion) return;

    const nextMessages = [...tutorMessages, { role: "user", content: cleanQuestion }];
    setTutorMessages(nextMessages);
    setTutorStatus("loading");
    setTutorError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/tutor-chat`, {
        method: "POST",
        headers: aiHeaders(),
        body: JSON.stringify({
          goal,
          question: cleanQuestion,
          messages: tutorMessages.slice(-6)
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Không hỏi được gia sư AI.");
      }

      setTutorMessages([...nextMessages, { role: "assistant", content: formatTutorAnswer(data) }]);
      setTutorStatus("done");
    } catch (error) {
      setTutorError(`${error.message || "Không kết nối được gia sư AI."} URL: ${apiBaseUrl || "cùng host"}`);
      setTutorStatus("error");
    }
  };

  const analyzeMistake = async (mistake) => {
    setMistakeStatus("loading");
    setMistakeError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/mistake-analysis`, {
        method: "POST",
        headers: aiHeaders(),
        body: JSON.stringify({ mistake })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Không phân tích được lỗi sai.");
      }

      setMistakes([
        {
          id: Date.now(),
          createdAt: new Date().toLocaleDateString("vi-VN"),
          ...mistake,
          analysis: data
        },
        ...mistakes
      ]);
      setMistakeStatus("done");
    } catch (error) {
      setMistakeError(`${error.message || "Không kết nối được AI phân tích lỗi sai."} URL: ${apiBaseUrl || "cùng host"}`);
      setMistakeStatus("error");
    }
  };

  const importMistakeTask = (mistake) => {
    const task = mistake.analysis?.scheduleTask || { title: "Sửa lỗi sai", minutes: 45 };
    setTasks([
      {
        day: "Hôm nay",
        block: "20:30",
        title: task.title,
        mode: `Sửa lỗi: ${mistake.analysis?.type || mistake.subject}`,
        minutes: Number(task.minutes || 45),
        done: false
      },
      ...tasks
    ]);
    navigateTo("schedule");
  };

  const handleAuth = async ({ mode, name, email, password }) => {
    const normalizedEmail = email.trim().toLowerCase();

    try {
      const data = await apiRequest(`/api/auth/${mode === "register" ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ name, email: normalizedEmail, password, goal })
      });

      if (data.state?.goal) setGoal(data.state.goal);
      if (Array.isArray(data.state?.tasks) && data.state.tasks.length) setTasks(data.state.tasks);
      if (typeof data.state?.proofs === "number") setProofs(data.state.proofs);

      setAuthUser({ ...data.user, source: "server" });
      setStudySyncStatus("server");
      return "";
    } catch (error) {
      if (error.status === 409) return "Email này đã có tài khoản.";
      if (error.status === 401) return "Email hoặc mật khẩu không đúng.";
      setStudySyncStatus("local");
    }

    if (mode === "register") {
      if (users.some((user) => user.email === normalizedEmail)) {
        return "Email này đã có tài khoản.";
      }

      const nextUser = {
        id: Date.now(),
        name: name.trim() || "Học sinh mới",
        email: normalizedEmail,
        password,
        joinedAt: new Date().toLocaleDateString("vi-VN")
      };

      setUsers([...users, nextUser]);
      setAuthUser({ ...withoutPassword(nextUser), source: "local" });
      return "";
    }

    const found = users.find((user) => user.email === normalizedEmail && user.password === password);
    if (!found) return "Email hoặc mật khẩu không đúng.";

    setAuthUser({ ...withoutPassword(found), source: "local" });
    return "";
  };

  if (!authUser) {
    return <AuthScreen onSubmit={handleAuth} />;
  }

  return (
    <div className="app-shell">
      <header className="mobile-appbar">
        <div className="brand">
          <div className="brand-mark"><GraduationCap size={22} /></div>
          <div>
            <strong>Study Compass</strong>
            <span>{authUser.name} · {studySyncStatus === "server" ? "Server" : "Local"}</span>
          </div>
        </div>
        <button className="icon-button" onClick={() => setAuthUser(null)} title="Đăng xuất">
          <LogOut size={18} />
        </button>
      </header>

      <main className="content">
        <header className="topbar">
          <p className="eyebrow">Hôm nay</p>
          <h1>{screenTitle(active)}</h1>
        </header>

        {active === "dashboard" && (
          <Dashboard
            goal={goal}
            tasks={tasks}
            doneCount={doneCount}
            totalStudy={totalStudy}
            streak={streak}
            plan={plan}
            setActive={navigateTo}
          />
        )}
        {active === "planner" && (
          <Planner
            goal={goal}
            setGoal={setGoal}
            plan={plan}
            aiPlan={aiPlan}
            aiStatus={aiStatus}
            aiError={aiError}
            onGenerate={generateAiPlan}
            onImportToday={importAiToday}
            onClearAi={() => setAiPlan(null)}
            tutorMessages={tutorMessages}
            tutorStatus={tutorStatus}
            tutorError={tutorError}
            onAskTutor={askTutor}
            onClearTutor={() => setTutorMessages([])}
            mistakes={mistakes}
            mistakeStatus={mistakeStatus}
            mistakeError={mistakeError}
            onAnalyzeMistake={analyzeMistake}
            onImportMistakeTask={importMistakeTask}
            apiHealth={apiHealth}
            apiBaseUrl={apiBaseUrl}
          />
        )}
        {active === "schedule" && (
          <Schedule
            tasks={tasks}
            setTasks={setTasks}
            reminderStatus={reminderStatus}
            onScheduleReminder={scheduleStudyReminder}
            onScheduleAllReminders={scheduleAllStudyReminders}
          />
        )}
        {active === "focus" && (
          <Focus
            minutes={minutes}
            setMinutes={setMinutes}
            running={running}
            setRunning={setRunning}
            apps={deviceApps}
            usageStatus={usageStatus}
            onRefreshUsage={refreshUsageStats}
            onOpenUsageSettings={openUsageSettings}
          />
        )}
        {active === "timelapse" && (
          <Timelapse
            user={authUser}
            clips={timelapses}
            setClips={setTimelapses}
            posts={posts}
            setPosts={setPosts}
            setActive={navigateTo}
          />
        )}
        {active === "profile" && (
          <Profile
            user={authUser}
            proofs={proofs}
            totalStudy={totalStudy}
            doneCount={doneCount}
            streak={streak}
            posts={posts}
            mistakes={mistakes}
            timelapses={timelapses}
          />
        )}
        {active === "social" && (
          <Social
            user={authUser}
            posts={posts}
            setPosts={setPosts}
            groups={studyGroups}
            setGroups={setStudyGroups}
            socialStatus={socialStatus}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="Thanh điều hướng chính">
        <NavButton icon={LayoutDashboard} label="Tổng quan" active={active === "dashboard"} onClick={() => navigateTo("dashboard")} />
        <NavButton icon={Sparkles} label="AI" active={active === "planner"} onClick={() => navigateTo("planner")} />
        <NavButton icon={CalendarDays} label="Lịch" active={active === "schedule"} onClick={() => navigateTo("schedule")} />
        <NavButton icon={Clock3} label="Tập trung" active={active === "focus"} onClick={() => navigateTo("focus")} />
        <NavButton icon={Video} label="Quay" active={active === "timelapse"} onClick={() => navigateTo("timelapse")} />
        <NavButton icon={Medal} label="Hồ sơ" active={active === "profile"} onClick={() => navigateTo("profile")} />
        <NavButton icon={UsersRound} label="Feed" active={active === "social"} onClick={() => navigateTo("social")} />
      </nav>
    </div>
  );
}

function Dashboard({ goal, tasks, doneCount, totalStudy, streak, plan, setActive }) {
  return (
    <section className="dashboard-grid">
      <Metric icon={Target} label="Mục tiêu chính" value={goal.subject} note={goal.target} />
      <article className="metric streak-metric">
        <Flame size={24} />
        <span>Chuỗi học</span>
        <strong>{streak.days} ngày</strong>
        <p>{streak.title} · {streak.next}</p>
        <div className="streak-track">
          <i style={{ width: `${streak.progress}%` }} />
        </div>
      </article>
      <Metric icon={Clock3} label="Giờ học đã xác nhận" value={`${Math.round(totalStudy / 60)}h`} note={`${doneCount}/${tasks.length} phiên hoàn thành`} />

      <div className="panel wide">
        <div className="panel-title">
          <BookOpenCheck size={20} />
          <h2>Lộ trình AI đề xuất</h2>
        </div>
        <div className="timeline">
          {plan.map((item, index) => (
            <div className="timeline-item" key={item.title}>
              <span>{index + 1}</span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <AlarmClock size={20} />
          <h2>Deadline gần</h2>
        </div>
        {tasks.slice(0, 3).map((task) => (
          <div className="deadline-row" key={`${task.day}-${task.title}`}>
            <span>{task.block}</span>
            <div>
              <strong>{task.title}</strong>
              <p>{task.day} · {task.minutes} phút</p>
            </div>
          </div>
        ))}
        <button className="text-action" onClick={() => setActive("schedule")}>Mở lịch học</button>
        <button className="text-action subtle-action" onClick={() => setActive("planner")}>Đổi mục tiêu học</button>
      </div>
    </section>
  );
}

function AuthScreen({ onSubmit }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: ""
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    if (!form.email.trim() || !form.password.trim()) {
      setError("Nhập email và mật khẩu trước đã.");
      return;
    }

    setSubmitting(true);
    const nextError = await onSubmit({ mode, ...form });
    setSubmitting(false);
    if (nextError) setError(nextError);
  };

  return (
    <div className="auth-shell">
      <section className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-mark"><GraduationCap size={22} /></div>
          <div>
            <strong>Study Compass</strong>
            <span>Tài khoản học tập cá nhân</span>
          </div>
        </div>

        <div className="auth-copy">
          <p className="eyebrow">{mode === "login" ? "Chào mừng trở lại" : "Tạo hồ sơ mới"}</p>
          <h1>{mode === "login" ? "Đăng nhập" : "Đăng ký"}</h1>
        </div>

        <div className="auth-switch">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Đăng nhập</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Đăng ký</button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && (
            <label>
              Tên hiển thị
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ví dụ: Minh Anh" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="ban@example.com" />
          </label>
          <label>
            Mật khẩu
            <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Tối thiểu 6 ký tự" />
          </label>
          {error && <p className="inline-error">{error}</p>}
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? "Đang kết nối" : mode === "login" ? "Vào app" : "Tạo tài khoản"}
          </button>
        </form>
      </section>
    </div>
  );
}

function Planner({
  goal,
  setGoal,
  plan,
  aiPlan,
  aiStatus,
  aiError,
  onGenerate,
  onImportToday,
  onClearAi,
  tutorMessages,
  tutorStatus,
  tutorError,
  onAskTutor,
  onClearTutor,
  mistakes,
  mistakeStatus,
  mistakeError,
  onAnalyzeMistake,
  onImportMistakeTask,
  apiHealth,
  apiBaseUrl
}) {
  const [mistakeDraft, setMistakeDraft] = useState({
    subject: goal.subject,
    problem: "",
    wrongAnswer: "",
    selfReason: "Chưa hiểu bản chất"
  });

  const [tutorDraft, setTutorDraft] = useState("");

  const submitMistake = () => {
    if (!mistakeDraft.problem.trim()) return;
    onAnalyzeMistake(mistakeDraft);
    setMistakeDraft({ ...mistakeDraft, problem: "", wrongAnswer: "" });
  };

  const submitTutor = () => {
    if (!tutorDraft.trim()) return;
    onAskTutor(tutorDraft);
    setTutorDraft("");
  };

  return (
    <section className="split-layout">
      <form className="panel planner-form">
        <div className={`api-status ${apiHealth.status}`}>
          <span>{apiHealth.message}</span>
          <code>{apiBaseUrl || "/api"}</code>
        </div>
        <div className="panel-title">
          <Sparkles size={20} />
          <h2>Thông tin học tập</h2>
        </div>
        <label>
          Môn học
          <input value={goal.subject} onChange={(event) => setGoal({ ...goal, subject: event.target.value })} />
        </label>
        <label>
          Mục tiêu
          <textarea value={goal.target} onChange={(event) => setGoal({ ...goal, target: event.target.value })} />
        </label>
        <label>
          Ngày kiểm tra
          <input type="date" value={goal.examDate} onChange={(event) => setGoal({ ...goal, examDate: event.target.value })} />
        </label>
        <label>
          Trình độ hiện tại
          <select value={goal.level} onChange={(event) => setGoal({ ...goal, level: event.target.value })}>
            <option>Mất gốc một phần</option>
            <option>Cơ bản ổn</option>
            <option>Muốn nâng cao</option>
          </select>
        </label>
        <label>
          Giờ học mỗi ngày
          <input type="number" min="1" max="8" value={goal.hoursPerDay} onChange={(event) => setGoal({ ...goal, hoursPerDay: Number(event.target.value) })} />
        </label>
        <button className="primary-action" type="button" onClick={onGenerate} disabled={aiStatus === "loading"}>
          <Sparkles size={18} />
          {aiStatus === "loading" ? "AI đang lập lịch" : "Tạo bằng Gemini"}
        </button>
        {aiError && <p className="inline-error">{aiError}</p>}
      </form>

      <div className="panel plan-output">
        <div className="panel-title spread">
          <div>
            <Target size={20} />
            <h2>{aiPlan ? "Kế hoạch Gemini" : "Kế hoạch tự động"}</h2>
          </div>
          {aiPlan && (
            <button className="icon-button" onClick={onClearAi} title="Xóa kế hoạch AI">
              <RefreshCw size={18} />
            </button>
          )}
        </div>
        {plan.map((item) => (
          <article className="plan-step" key={item.title}>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </article>
        ))}
        {aiPlan?.today?.length > 0 && (
          <div className="today-plan">
            <strong>Lịch hôm nay</strong>
            {aiPlan.today.map((item) => (
              <div className="deadline-row" key={`${item.time}-${item.title}`}>
                <span>{item.time}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.minutes} phút</p>
                </div>
              </div>
            ))}
            <button className="text-action" onClick={onImportToday}>Đưa vào lịch học</button>
          </div>
        )}
        {aiPlan?.warning && <p className="ai-warning">{aiPlan.warning}</p>}
      </div>

      <div className="panel tutor-panel">
        <div className="panel-title spread">
          <div>
            <MessageSquarePlus size={20} />
            <h2>Gia sư AI</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClearTutor} title="Xóa hội thoại">
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="tutor-chat">
          {tutorMessages.length === 0 && (
            <p className="empty-state">Gửi câu hỏi, bài tập hoặc phần đang kẹt để gia sư AI gợi ý từng bước.</p>
          )}
          {tutorMessages.map((message, index) => (
            <article className={`tutor-message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "assistant" ? "Gia sư" : "Bạn"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
        <div className="tutor-form">
          <textarea
            value={tutorDraft}
            onChange={(event) => setTutorDraft(event.target.value)}
            placeholder="Nhập câu hỏi hoặc dán đề bài..."
          />
          <button className="primary-action" type="button" onClick={submitTutor} disabled={tutorStatus === "loading"}>
            <Send size={18} />
            {tutorStatus === "loading" ? "Đang hỏi" : "Hỏi gia sư"}
          </button>
          {tutorError && <p className="inline-error">{tutorError}</p>}
        </div>
      </div>

      <div className="panel mistake-panel">
        <div className="panel-title">
          <BookOpenCheck size={20} />
          <h2>Nhật ký lỗi sai</h2>
        </div>
        <div className="mistake-form">
          <label>
            Môn học
            <input
              value={mistakeDraft.subject}
              onChange={(event) => setMistakeDraft({ ...mistakeDraft, subject: event.target.value })}
            />
          </label>
          <label>
            Đề bài hoặc mô tả lỗi
            <textarea
              value={mistakeDraft.problem}
              onChange={(event) => setMistakeDraft({ ...mistakeDraft, problem: event.target.value })}
              placeholder="Ví dụ: Em nhầm điều kiện xác định của hàm số..."
            />
          </label>
          <label>
            Cách làm hoặc đáp án sai
            <textarea
              value={mistakeDraft.wrongAnswer}
              onChange={(event) => setMistakeDraft({ ...mistakeDraft, wrongAnswer: event.target.value })}
              placeholder="Ghi phần em đã làm sai để AI phân tích kỹ hơn"
            />
          </label>
          <label>
            Em nghĩ mình sai vì
            <select
              value={mistakeDraft.selfReason}
              onChange={(event) => setMistakeDraft({ ...mistakeDraft, selfReason: event.target.value })}
            >
              <option>Chưa hiểu bản chất</option>
              <option>Quên công thức</option>
              <option>Đọc sai đề</option>
              <option>Tính toán sai</option>
              <option>Thiếu thời gian</option>
            </select>
          </label>
          <button className="primary-action" type="button" onClick={submitMistake} disabled={mistakeStatus === "loading"}>
            <Sparkles size={18} />
            {mistakeStatus === "loading" ? "AI đang phân tích" : "Phân tích lỗi sai"}
          </button>
          {mistakeError && <p className="inline-error">{mistakeError}</p>}
        </div>
      </div>

      {mistakes.length > 0 && (
        <div className="mistake-list">
          {mistakes.map((mistake) => (
            <article className="mistake-card" key={mistake.id}>
              <header>
                <span>{mistake.createdAt}</span>
                <strong>{mistake.analysis.type}</strong>
              </header>
              <p>{mistake.problem}</p>
              <div className="analysis-grid">
                <div>
                  <span>Vì sao sai</span>
                  <p>{mistake.analysis.why}</p>
                </div>
                <div>
                  <span>Cần sửa</span>
                  <p>{mistake.analysis.fix}</p>
                </div>
                <div>
                  <span>Ôn lại</span>
                  <p>{mistake.analysis.review}</p>
                </div>
                <div>
                  <span>Bài sửa lỗi</span>
                  <p>{mistake.analysis.practice}</p>
                </div>
              </div>
              <button className="text-action" type="button" onClick={() => onImportMistakeTask(mistake)}>
                Đưa bài sửa lỗi vào lịch
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Schedule({ tasks, setTasks, reminderStatus, onScheduleReminder, onScheduleAllReminders }) {
  const [editingIndex, setEditingIndex] = useState(null);
  const [draft, setDraft] = useState(null);

  const addTask = () => {
    const nextTask = { day: "Hôm nay", block: "20:00", title: "Phiên học mới", mode: "Học sâu", minutes: 45, done: false };
    setTasks([...tasks, nextTask]);
    setEditingIndex(tasks.length);
    setDraft(nextTask);
  };

  const startEdit = (task, index) => {
    setEditingIndex(index);
    setDraft({ ...task });
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setDraft(null);
  };

  const saveEdit = () => {
    if (editingIndex === null || !draft) return;

    const nextTask = {
      ...draft,
      title: draft.title.trim() || "Phiên học",
      day: draft.day.trim() || "Hôm nay",
      block: draft.block || "20:00",
      mode: draft.mode.trim() || "Học sâu",
      minutes: Math.max(1, Math.min(480, Number(draft.minutes || 45)))
    };

    setTasks(tasks.map((task, index) => index === editingIndex ? nextTask : task));
    cancelEdit();
  };

  const deleteTask = (index) => {
    setTasks(tasks.filter((_, taskIndex) => taskIndex !== index));
    cancelEdit();
  };

  return (
    <section className="panel full-panel">
      <div className="panel-title spread">
        <div>
          <CalendarDays size={20} />
          <h2>Lịch học và nhắc nhở</h2>
        </div>
        <div className="schedule-actions">
          <button className="icon-button" type="button" onClick={onScheduleAllReminders} title="Bật nhắc các lịch sắp tới">
            <BellRing size={18} />
          </button>
          <button className="icon-button" type="button" onClick={addTask} title="Thêm phiên học"><Plus size={18} /></button>
        </div>
      </div>
      {reminderStatus?.message && (
        <div className={`reminder-status ${reminderStatus.source}`}>
          <BellRing size={16} />
          <span>{reminderStatus.message}</span>
        </div>
      )}
      <div className="task-grid">
        {tasks.map((task, index) => {
          const isEditing = editingIndex === index;

          return (
            <article className={`task-card ${task.done ? "is-done" : ""} ${isEditing ? "is-editing" : ""}`} key={`${task.title}-${index}`}>
              {isEditing ? (
                <div className="task-edit-form">
                  <div className="task-edit-row">
                    <label>
                      Ngày
                      <input value={draft.day} onChange={(event) => setDraft({ ...draft, day: event.target.value })} />
                    </label>
                    <label>
                      Giờ
                      <input type="time" value={draft.block} onChange={(event) => setDraft({ ...draft, block: event.target.value })} />
                    </label>
                  </div>
                  <label>
                    Nội dung
                    <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                  </label>
                  <div className="task-edit-row">
                    <label>
                      Chế độ
                      <input value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value })} />
                    </label>
                    <label>
                      Phút
                      <input
                        type="number"
                        min="1"
                        max="480"
                        value={draft.minutes}
                        onChange={(event) => setDraft({ ...draft, minutes: event.target.value })}
                      />
                    </label>
                  </div>
                  <div className="task-actions">
                    <button className="mini-action primary-mini" type="button" onClick={saveEdit} title="Lưu lịch học">
                      <Save size={16} />
                      Lưu
                    </button>
                    <button className="mini-action" type="button" onClick={cancelEdit} title="Hủy chỉnh sửa">
                      <X size={16} />
                      Hủy
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button className="check-button" type="button" onClick={() => toggleTask(tasks, setTasks, index)} title="Đổi trạng thái">
                    <CheckCircle2 size={20} />
                  </button>
                  <span>{task.day} · {task.block}</span>
                  <strong>{task.title}</strong>
                  <p>{task.mode} · {task.minutes} phút</p>
                  <div className="task-actions">
                    <button className="mini-action" type="button" onClick={() => onScheduleReminder(task, index)} title="Đặt nhắc lịch này">
                      <BellRing size={16} />
                      Nhắc
                    </button>
                    <button className="mini-action" type="button" onClick={() => startEdit(task, index)} title="Sửa lịch học">
                      <Edit3 size={16} />
                      Sửa
                    </button>
                    <button className="mini-action danger-mini" type="button" onClick={() => deleteTask(index)} title="Xóa lịch học">
                      <Trash2 size={16} />
                      Xóa
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Focus({ minutes, setMinutes, running, setRunning, apps, usageStatus, onRefreshUsage, onOpenUsageSettings }) {
  const display = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

  return (
    <section className="focus-grid">
      <div className="panel timer-panel">
        <div className="panel-title">
          <Clock3 size={20} />
          <h2>Pomodoro sinh học</h2>
        </div>
        <div className="timer">{display}</div>
        <div className="segmented">
          {[25, 45, 60].map((value) => (
            <button key={value} onClick={() => setMinutes(value * 60)}>{value}p</button>
          ))}
        </div>
        <div className="timer-actions">
          <button className="primary-action" onClick={() => setRunning(!running)}>
            {running ? <Pause size={18} /> : <Play size={18} />}
            {running ? "Tạm dừng" : "Bắt đầu"}
          </button>
          <button className="icon-button" onClick={() => { setRunning(false); setMinutes(25 * 60); }} title="Đặt lại">
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      <div className="panel app-usage">
        <div className="panel-title spread">
          <div>
            <Gauge size={20} />
            <h2>Đánh giá dùng thiết bị</h2>
          </div>
          <button className="icon-button" type="button" onClick={onRefreshUsage} title="Cập nhật thời gian dùng app">
            <RefreshCw size={18} />
          </button>
        </div>
        <div className={`usage-status ${usageStatus.source}`}>
          <p>{usageStatus.message}</p>
          {usageStatus.source === "permission" && (
            <button className="text-action" type="button" onClick={onOpenUsageSettings}>Cấp quyền Usage Access</button>
          )}
        </div>
        {apps.map((app) => (
          <div className="usage-row" key={app.packageName || app.name}>
            <div>
              <strong>{app.name}</strong>
              <p>{app.type}{app.lastUsed ? ` · dùng gần nhất ${formatLastUsed(app.lastUsed)}` : ""}</p>
            </div>
            <span>{formatUsageMinutes(app.minutes)}</span>
            <em>{app.effect}</em>
          </div>
        ))}
        {usageStatus.source === "real" && apps.length === 0 && (
          <p className="empty-state">Chưa có app nào trong cửa sổ 24 giờ gần đây.</p>
        )}
      </div>
    </section>
  );
}

function Timelapse({ user, clips, setClips, posts, setPosts, setActive }) {
  const [draft, setDraft] = useState({
    title: "Phiên học timelapse",
    minutes: 45
  });
  const [clipError, setClipError] = useState("");

  const saveClip = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 7_500_000) {
      setClipError("Video hơi nặng. Hãy quay ngắn hơn hoặc nén xuống dưới khoảng 7 MB để app lưu ổn định.");
      return;
    }

    const video = await fileToDataUrl(file);
    const nextClip = {
      id: Date.now(),
      title: draft.title.trim() || "Phiên học timelapse",
      minutes: Number(draft.minutes || 45),
      video,
      createdAt: new Date().toLocaleString("vi-VN"),
      author: user.name
    };

    setClipError("");
    setClips([nextClip, ...clips]);
    event.target.value = "";
  };

  const publishClip = (clip) => {
    const nextPost = {
      id: Date.now(),
      author: user.name,
      badge: "Timelapse",
      type: "Timelapse",
      content: `${clip.title} - ${clip.minutes} phút học có video ghi lại.`,
      proof: "Video timelapse",
      image: clip.video,
      studyMinutes: clip.minutes,
      likes: 0,
      comments: [],
      liked: false
    };

    setPosts([nextPost, ...posts]);
    setActive("social");
  };

  return (
    <section className="timelapse-layout">
      <div className="panel timelapse-recorder">
        <div className="panel-title">
          <Video size={20} />
          <h2>Quay timelapse học</h2>
        </div>
        <div className="timelapse-form">
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="Tên phiên học"
          />
          <input
            type="number"
            min="5"
            max="240"
            value={draft.minutes}
            onChange={(event) => setDraft({ ...draft, minutes: event.target.value })}
            aria-label="Số phút học"
          />
          <label className="image-picker">
            <Video size={18} />
            Quay hoặc chọn video timelapse
            <input type="file" accept="video/*" capture="environment" onChange={saveClip} />
          </label>
          {clipError && <p className="inline-error">{clipError}</p>}
        </div>
      </div>

      <div className="clip-list">
        {clips.length === 0 && (
          <p className="empty-state">Chưa có timelapse nào. Quay một video ngắn khi học rồi đăng lên Feed để tăng uy tín học tập.</p>
        )}
        {clips.map((clip) => (
          <article className="clip-card" key={clip.id}>
            <video className="post-video" src={clip.video} controls playsInline />
            <div>
              <strong>{clip.title}</strong>
              <p>{clip.createdAt} · {clip.minutes} phút</p>
            </div>
            <button className="primary-action" type="button" onClick={() => publishClip(clip)}>
              <Send size={18} />
              Đăng lên Feed
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function Profile({ user, proofs, totalStudy, doneCount, streak, posts, mistakes, timelapses }) {
  const badges = makeProfileBadges({ proofs, totalStudy, doneCount, streak, posts, mistakes, timelapses, user });

  return (
    <section className="profile-layout">
      <div className="profile-hero">
        <div>
          <p className="eyebrow">Hồ sơ học tập</p>
          <h2>{user.name}</h2>
          <p>{user.email} · {streak.title} · trưng bày huy hiệu để giữ động lực học.</p>
        </div>
      </div>
      <Metric icon={Trophy} label="Thành tích" value={`${proofs} minh chứng`} note="Ảnh, timelapse hoặc ghi chú học" />
      <Metric icon={BarChart3} label="Kỷ luật" value={`${doneCount} phiên`} note={`${totalStudy} phút học đã ghi nhận`} />
      <Metric icon={Flame} label="Uy tín" value={streak.title} note={`${streak.days} ngày streak · ${streak.next}`} />
      <div className="panel badge-showcase">
        <div className="panel-title">
          <Award size={20} />
          <h2>Huy hiệu trưng bày</h2>
        </div>
        <div className="badge-grid">
          {badges.map((badge) => {
            const Icon = badge.icon;
            return (
              <article className={`badge-card ${badge.unlocked ? "unlocked" : ""}`} key={badge.title}>
                <Icon size={20} />
                <strong>{badge.title}</strong>
                <p>{badge.detail}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Social({ user, posts, setPosts, groups, setGroups, socialStatus }) {
  const [draft, setDraft] = useState({
    type: "Điểm số",
    content: "",
    proof: "Ảnh minh chứng",
    studyMinutes: 90,
    image: "",
    mediaType: ""
  });
  const [commentDrafts, setCommentDrafts] = useState({});
  const [groupDraft, setGroupDraft] = useState({ name: "", description: "" });
  const [groupView, setGroupView] = useState("mine");
  const [socialError, setSocialError] = useState("");
  const serverUserId = user?.source === "server" ? user.id : null;
  const myGroups = groups.filter((group) => group.joined);
  const discoverGroups = groups.filter((group) => !group.joined);
  const visibleGroups = groupView === "mine" ? myGroups : discoverGroups;
  const joinedGroups = {
    includes: (groupKey) => groups.some((group) => String(group.id || group.name) === groupKey && group.joined)
  };

  const publishPost = async () => {
    const content = draft.content.trim();
    if (!content) return;

    const nextPost = {
      id: Date.now(),
      author: user.name,
      badge: "Vừa đăng",
      type: draft.type,
      content,
      proof: draft.proof,
      image: draft.image,
      mediaType: draft.mediaType,
      studyMinutes: Number(draft.studyMinutes || 0),
      likes: 0,
      comments: [],
      liked: false,
      localOnly: false
    };

    setSocialError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post: nextPost, userId: serverUserId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không đăng được bài.");
      setPosts([data, ...posts]);
    } catch (error) {
      setSocialError(error.message || "Đang lưu tạm trên máy vì chưa kết nối server.");
      setPosts([{ ...nextPost, badge: "Chưa đồng bộ", localOnly: true }, ...posts]);
    }

    setDraft({ ...draft, content: "", image: "", mediaType: "" });
  };

  const attachMedia = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 7_500_000) {
      setSocialError("Video hơi nặng. Hãy chọn video dưới khoảng 7 MB hoặc nén trước khi đăng.");
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setDraft((current) => ({
      ...current,
      image: String(reader.result || ""),
      mediaType: file.type.startsWith("video/") ? "video" : "image"
    }));
    reader.readAsDataURL(file);
  };

  const toggleLike = (postId) => {
    setPosts(posts.map((post) => {
      if (post.id !== postId) return post;
      return {
        ...post,
        liked: !post.liked,
        likes: post.liked ? Math.max(0, post.likes - 1) : post.likes + 1
      };
    }));
  };

  const addCommentToPost = (postId, comment) => {
    setPosts(posts.map((post) => {
      if (post.id !== postId) return post;
      const comments = Array.isArray(post.comments) ? post.comments : [];
      return { ...post, comments: [...comments, comment] };
    }));
  };

  const publishComment = async (postId) => {
    const content = (commentDrafts[postId] || "").trim();
    if (!content) return;

    const nextComment = {
      id: Date.now(),
      author: user.name,
      content,
      createdAt: new Date().toLocaleString("vi-VN")
    };

    setCommentDrafts({ ...commentDrafts, [postId]: "" });
    setSocialError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: nextComment })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không gửi được bình luận.");
      addCommentToPost(postId, data);
    } catch (error) {
      setSocialError(error.message || "Bình luận đang lưu tạm trên máy.");
      addCommentToPost(postId, nextComment);
    }
  };

  const createGroup = async () => {
    const name = groupDraft.name.trim();
    if (!name) return;

    const nextGroup = {
      id: Date.now(),
      name,
      description: groupDraft.description.trim(),
      ownerName: user.name,
      members: 1,
      streak: 1,
      rank: 99
    };

    setSocialError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: nextGroup, userId: serverUserId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không tạo được nhóm.");
      setGroups([{ ...data, joined: true }, ...groups]);
      setGroupView("mine");
    } catch (error) {
      setSocialError(error.message || "Nhóm đang lưu tạm trên máy.");
      setGroups([{ ...nextGroup, joined: true }, ...groups]);
      setGroupView("mine");
    }

    setGroupDraft({ name: "", description: "" });
  };

  const joinGroup = async (group) => {
    const groupKey = String(group.id || group.name);
    if (group.joined) return;

    const applyJoinedGroup = (nextGroup) => {
      setGroups(groups.map((item) => {
        const itemKey = String(item.id || item.name);
        return itemKey === groupKey ? { ...item, ...nextGroup, joined: true, members: Number(nextGroup.members || item.members + 1) } : item;
      }));
      setGroupView("mine");
    };

    setSocialError("");

    if (!group.id || !serverUserId) {
      applyJoinedGroup({ members: Number(group.members || 0) + 1 });
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/groups/${group.id}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: serverUserId, memberName: user.name })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không vào được nhóm.");
      applyJoinedGroup(data);
    } catch (error) {
      setSocialError(error.message || "Đã vào nhóm tạm trên máy.");
      applyJoinedGroup({ members: Number(group.members || 0) + 1 });
    }
  };

  const leaveGroup = async (group) => {
    const groupKey = String(group.id || group.name);

    const applyLeftGroup = (nextGroup) => {
      setGroups(groups.map((item) => {
        const itemKey = String(item.id || item.name);
        return itemKey === groupKey
          ? { ...item, ...nextGroup, joined: false, members: Number(nextGroup.members ?? Math.max(0, item.members - 1)) }
          : item;
      }));
    };

    setSocialError("");

    if (!group.id || !serverUserId) {
      applyLeftGroup({ members: Math.max(0, Number(group.members || 0) - 1) });
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/groups/${group.id}/join`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: serverUserId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không rời được nhóm.");
      applyLeftGroup(data);
    } catch (error) {
      setSocialError(error.message || "Đã rời nhóm tạm trên máy.");
      applyLeftGroup({ members: Math.max(0, Number(group.members || 0) - 1) });
    }
  };

  return (
    <section className="social-layout">
      <div className="panel composer-panel">
        <div className="panel-title spread">
          <div>
            <UsersRound size={20} />
            <h2>Flex thành tích</h2>
          </div>
          <span className="feed-badge">{socialStatus === "server" ? "Server" : "Máy cá nhân"}</span>
        </div>
        <div className="composer-form">
          <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
            <option>Điểm số</option>
            <option>Chuỗi học</option>
            <option>Hoàn thành mục tiêu</option>
            <option>Contest</option>
            <option>Minh chứng học tập</option>
            <option>Hỏi bài</option>
          </select>
          <textarea
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            placeholder={draft.type === "Hỏi bài" ? "Bạn đang mắc ở bài nào? Mô tả đề hoặc chỗ chưa hiểu..." : "Bạn vừa đạt được gì? Khoe thành tựu học tập một chút..."}
          />
          <div className="composer-row">
            <input
              value={draft.proof}
              onChange={(event) => setDraft({ ...draft, proof: event.target.value })}
              placeholder="Minh chứng"
            />
            <input
              type="number"
              min="0"
              value={draft.studyMinutes}
              onChange={(event) => setDraft({ ...draft, studyMinutes: event.target.value })}
              aria-label="Số phút học"
            />
          </div>
          <label className="image-picker">
            {isVideoMedia(draft.image) ? <Video size={18} /> : <Camera size={18} />}
            {draft.image ? `Đã chọn ${mediaLabel(draft.image)}` : "Gửi ảnh hoặc video minh chứng"}
            <input type="file" accept="image/*,video/*" onChange={attachMedia} />
          </label>
          {draft.image && (
            isVideoMedia(draft.image)
              ? <video className="video-preview" src={draft.image} controls playsInline />
              : <img className="image-preview" src={draft.image} alt="Ảnh minh chứng xem trước" />
          )}
          <button className="primary-action" type="button" onClick={publishPost}>
            <Send size={18} />
            {draft.type === "Hỏi bài" ? "Đăng câu hỏi" : "Đăng thành tích"}
          </button>
          {socialError && <p className="inline-error">{socialError}</p>}
        </div>
      </div>

      <div className="feed-list">
        {posts.map((post) => (
          <article className="post-card" key={post.id}>
            <header className="post-header">
              <div className="avatar">{post.author.slice(0, 1)}</div>
              <div>
                <strong>{post.author}</strong>
                <p>{post.badge} · {post.type}</p>
              </div>
            </header>
            <p className="post-content">{post.content}</p>
            {post.image && (
              isVideoMedia(post.image)
                ? <video className="post-video" src={post.image} controls playsInline />
                : <img className="post-image" src={post.image} alt="Minh chứng học tập" />
            )}
            <div className={`proof-card ${post.type === "Hỏi bài" ? "question" : ""}`}>
              {post.type === "Hỏi bài" ? <HelpCircle size={22} /> : isVideoMedia(post.image) ? <Video size={22} /> : <Trophy size={22} />}
              <div>
                <strong>{post.proof}</strong>
                <p>{post.type === "Hỏi bài" ? "Đang chờ cộng đồng hỗ trợ" : `${Math.round(post.studyMinutes / 60 * 10) / 10} giờ học được ghi nhận`}</p>
              </div>
            </div>
            <footer className="post-actions">
              <button className={post.liked ? "liked" : ""} onClick={() => toggleLike(post.id)}>
                <Heart size={18} />
                {post.likes}
              </button>
              <button type="button">
                <MessageSquarePlus size={18} />
                {Array.isArray(post.comments) ? post.comments.length : post.comments}
              </button>
            </footer>
            <div className="comment-list">
              {(Array.isArray(post.comments) ? post.comments : []).map((comment) => (
                <div className="comment-row" key={comment.id}>
                  <strong>{comment.author}</strong>
                  <p>{comment.content}</p>
                </div>
              ))}
            </div>
            <div className="comment-form">
              <input
                value={commentDrafts[post.id] || ""}
                onChange={(event) => setCommentDrafts({ ...commentDrafts, [post.id]: event.target.value })}
                placeholder="Viết bình luận..."
              />
              <button className="icon-button" type="button" onClick={() => publishComment(post.id)} title="Gửi bình luận">
                <Send size={17} />
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">
          <UsersRound size={20} />
          <h2>Nhóm học nổi bật</h2>
        </div>
        <div className="group-composer">
          <input
            value={groupDraft.name}
            onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })}
            placeholder="Tên nhóm học"
          />
          <textarea
            value={groupDraft.description}
            onChange={(event) => setGroupDraft({ ...groupDraft, description: event.target.value })}
            placeholder="Mục tiêu của nhóm"
          />
          <button className="primary-action" type="button" onClick={createGroup}>
            <Plus size={18} />
            Tạo nhóm
          </button>
        </div>
        <div className="group-tabs">
          <button className={groupView === "mine" ? "active" : ""} type="button" onClick={() => setGroupView("mine")}>
            Nhóm của tôi ({myGroups.length})
          </button>
          <button className={groupView === "discover" ? "active" : ""} type="button" onClick={() => setGroupView("discover")}>
            Khám phá ({discoverGroups.length})
          </button>
        </div>
        {visibleGroups.length === 0 && (
          <p className="empty-state">
            {groupView === "mine" ? "Bạn chưa vào nhóm nào. Chuyển sang Khám phá để tham gia nhóm học." : "Không còn nhóm mới để tham gia."}
          </p>
        )}
        <div className="group-list compact">
          {visibleGroups.map((group) => (
            <article className="group-row" key={group.id || group.name}>
              <div>
                <strong>{group.name}</strong>
                <p>{group.members} thành viên · chuỗi {group.streak} ngày</p>
                {group.description && <p>{group.description}</p>}
              </div>
              <div className="group-actions">
                <span>#{group.rank}</span>
                <button type="button" data-label={group.joined ? "Rời" : "Vào"} onClick={() => group.joined ? leaveGroup(group) : joinGroup(group)}>
                  <UserPlus size={16} />
                  {joinedGroups.includes(String(group.id || group.name)) ? "Đã vào" : "Vào"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function makeProfileBadges({ proofs, totalStudy, doneCount, streak, posts, mistakes, timelapses, user }) {
  const commentCount = posts.reduce((sum, post) => {
    const comments = Array.isArray(post.comments) ? post.comments : [];
    return sum + comments.filter((comment) => comment.author === user.name).length;
  }, 0);
  const helpCount = posts.filter((post) => post.author === user.name && post.type === "Hỏi bài").length + commentCount;
  const studyHours = Math.round(totalStudy / 60);

  return [
    {
      icon: Flame,
      title: "Giữ chuỗi",
      detail: `${streak.days} ngày học liên tục`,
      unlocked: streak.days >= 3
    },
    {
      icon: Clock3,
      title: "Giờ học thật",
      detail: `${studyHours} giờ đã ghi nhận`,
      unlocked: totalStudy >= 180
    },
    {
      icon: MessageCircle,
      title: "Người góp ý",
      detail: `${commentCount} bình luận hỗ trợ bạn học`,
      unlocked: commentCount > 0
    },
    {
      icon: HelpCircle,
      title: "Giải bài cộng đồng",
      detail: `${helpCount} lần hỏi/giúp bài`,
      unlocked: helpCount > 0
    },
    {
      icon: BookOpenCheck,
      title: "Sửa lỗi sai",
      detail: `${mistakes.length} lỗi sai đã phân tích`,
      unlocked: mistakes.length > 0
    },
    {
      icon: Video,
      title: "Timelapse học",
      detail: `${timelapses.length} video học tập`,
      unlocked: timelapses.length > 0
    },
    {
      icon: Trophy,
      title: "Minh chứng",
      detail: `${proofs} minh chứng tích lũy`,
      unlocked: proofs > 0
    },
    {
      icon: Award,
      title: "Hoàn thành phiên",
      detail: `${doneCount} phiên đã hoàn thành`,
      unlocked: doneCount > 0
    }
  ];
}

async function syncLocalOnlyPosts(serverPosts, user) {
  const savedPosts = load("posts", []);
  const serverUserId = user?.source === "server" ? user.id : null;
  const pendingPosts = savedPosts
    .filter((post) => (post.localOnly || Number(post.id) > 1_000_000_000_000) && post.author === user?.name)
    .filter((post) => !hasEquivalentPost(serverPosts, post));

  if (!pendingPosts.length || !apiBaseUrl || !serverUserId) {
    return [...pendingPosts, ...serverPosts];
  }

  const synced = [...serverPosts];
  const stillLocal = [];

  for (const post of pendingPosts.slice(0, 5)) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post, userId: serverUserId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Cannot sync local post.");
      if (!hasEquivalentPost(synced, data)) synced.unshift(data);
    } catch {
      stillLocal.push(post);
    }
  }

  return [...stillLocal, ...synced];
}

function hasEquivalentPost(posts, target) {
  return posts.some((post) => (
    post.id === target.id ||
    (post.author === target.author && post.content === target.content && post.proof === target.proof)
  ));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Không đọc được file."));
    reader.readAsDataURL(file);
  });
}

function isVideoMedia(value = "") {
  return String(value).startsWith("data:video/");
}

function mediaLabel(value = "") {
  return isVideoMedia(value) ? "video minh chứng" : "ảnh minh chứng";
}

function Metric({ icon: Icon, label, value, note }) {
  return (
    <article className="metric">
      <Icon size={22} />
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function NavButton({ icon: Icon, label, active, onClick }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      <Icon size={19} />
      <span>{label}</span>
    </button>
  );
}

function makePlan(goal) {
  const hours = Number(goal.hoursPerDay) || 1;
  return [
    { title: "Chẩn đoán lệch mục tiêu", detail: `Tách mục tiêu "${goal.target}" thành kỹ năng nhỏ, kiểm tra nhanh phần yếu của ${goal.subject}.` },
    { title: "Lịch học theo nhịp", detail: `Mỗi ngày ${hours} giờ: 70% học sâu, 20% luyện đề, 10% ghi lỗi sai và nghỉ đúng nhịp.` },
    { title: "Deadline ngắn hạn", detail: "Tạo mốc 3 ngày và 7 ngày để giữ chuỗi học, kèm nhắc nhở khi dùng app giải trí quá lâu." },
    { title: "Đánh giá bằng chứng", detail: "Mỗi phiên học lưu ảnh, timelapse hoặc ghi chú để tăng uy tín cá nhân và xếp hạng nhóm." }
  ];
}

function toggleTask(tasks, setTasks, index) {
  setTasks(tasks.map((task, taskIndex) => taskIndex === index ? { ...task, done: !task.done } : task));
}

function getTaskReminderDate(task, now = new Date()) {
  const time = parseTaskTime(task.block);
  if (!time) return null;

  const dayInfo = getTaskDayInfo(task.day, now);
  if (!dayInfo) return null;

  const reminderAt = new Date(now);
  reminderAt.setSeconds(0, 0);
  reminderAt.setHours(time.hours, time.minutes, 0, 0);
  reminderAt.setDate(now.getDate() + dayInfo.offset);

  if (reminderAt <= now && dayInfo.kind === "weekday") {
    reminderAt.setDate(reminderAt.getDate() + 7);
  }

  return reminderAt > now ? reminderAt : null;
}

function parseTaskTime(value = "") {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return { hours, minutes };
}

function getTaskDayInfo(value = "", now = new Date()) {
  const label = String(value).trim().toLocaleLowerCase("vi-VN");
  if (!label || label.includes("hôm nay")) return { offset: 0, kind: "relative" };
  if (label.includes("mai")) return { offset: 1, kind: "relative" };

  const weekdays = [
    ["chủ nhật", 0],
    ["chu nhat", 0],
    ["thứ 2", 1],
    ["thứ hai", 1],
    ["thu 2", 1],
    ["thu hai", 1],
    ["thứ 3", 2],
    ["thứ ba", 2],
    ["thu 3", 2],
    ["thu ba", 2],
    ["thứ 4", 3],
    ["thứ tư", 3],
    ["thu 4", 3],
    ["thu tu", 3],
    ["thứ 5", 4],
    ["thứ năm", 4],
    ["thu 5", 4],
    ["thu nam", 4],
    ["thứ 6", 5],
    ["thứ sáu", 5],
    ["thu 6", 5],
    ["thu sau", 5],
    ["thứ 7", 6],
    ["thứ bảy", 6],
    ["thu 7", 6],
    ["thu bay", 6]
  ];
  const found = weekdays.find(([name]) => label.includes(name));
  if (!found) return null;

  const offset = (found[1] - now.getDay() + 7) % 7;
  return { offset, kind: "weekday" };
}

function makeReminderId(task, index = 0) {
  const numericId = Number(task.id);
  const source = Number.isFinite(numericId) ? numericId : index + 1;
  return REMINDER_ID_BASE + (Math.abs(Math.trunc(source)) % 50_000);
}

function formatReminderTime(date) {
  return date.toLocaleString("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function calculateStreak(doneCount, totalStudy) {
  const days = Math.max(1, doneCount + Math.floor(totalStudy / 180));
  const tiers = [
    { min: 30, title: "Legend Streak", nextAt: 45 },
    { min: 14, title: "Diamond Streak", nextAt: 30 },
    { min: 7, title: "Gold Streak", nextAt: 14 },
    { min: 3, title: "Silver Streak", nextAt: 7 },
    { min: 1, title: "Bronze Streak", nextAt: 3 }
  ];
  const tier = tiers.find((item) => days >= item.min) || tiers[tiers.length - 1];
  const progress = Math.min(100, Math.round((days / tier.nextAt) * 100));

  return {
    days,
    title: tier.title,
    progress,
    next: days >= 45 ? "đang ở đỉnh bảng" : `còn ${Math.max(1, tier.nextAt - days)} ngày để lên hạng`
  };
}

function screenTitle(active) {
  const titles = {
    dashboard: "Bảng điều khiển học tập",
    planner: "AI lập lộ trình",
    schedule: "Lịch học cá nhân",
    focus: "Phiên tập trung",
    timelapse: "Timelapse học tập",
    profile: "Hồ sơ thành tích",
    social: "Xã hội học tập"
  };
  return titles[active];
}

function useNativeShell(onBackButton) {
  useEffect(() => {
    let backListener;
    let isMounted = true;

    const setupNativeShell = async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;

      const { App: CapacitorApp } = await import("@capacitor/app");
      const { StatusBar, Style } = await import("@capacitor/status-bar");
      const { SplashScreen } = await import("@capacitor/splash-screen");

      await StatusBar.setStyle({ style: Style.Light });
      await StatusBar.setBackgroundColor({ color: "#f7f8f2" });
      await SplashScreen.hide();

      backListener = await CapacitorApp.addListener("backButton", onBackButton);

      if (!isMounted) {
        backListener?.remove();
      }
    };

    setupNativeShell().catch(() => {});

    return () => {
      isMounted = false;
      backListener?.remove();
    };
  }, [onBackButton]);
}

function load(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    console.warn(`Cannot save ${key} to localStorage. The payload may be too large.`);
  }
}

function formatUsageMinutes(value) {
  const minutes = Number(value || 0);
  if (minutes < 60) return `${minutes}p`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}p` : `${hours}h`;
}

function formatLastUsed(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "";
  return new Date(value).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function formatTutorAnswer(data) {
  const sections = [data.answer].filter(Boolean);

  if (Array.isArray(data.steps) && data.steps.length) {
    const label = data.type === "knowledge" ? "Ý chính" : "Các bước";
    sections.push(`${label}:\n${data.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }

  if (data.hint && data.type !== "knowledge") sections.push(`Gợi ý: ${data.hint}`);
  if (data.practice) sections.push(`Luyện tiếp: ${data.practice}`);
  if (data.followUp) sections.push(`Hỏi tiếp: ${data.followUp}`);

  return sections.join("\n\n");
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function aiHeaders() {
  return {
    "Content-Type": "application/json",
    ...(aiRequestSecret ? { "x-study-compass-key": aiRequestSecret } : {})
  };
}

function withoutPassword(user) {
  const { password, ...safeUser } = user;
  return safeUser;
}

createRoot(document.getElementById("root")).render(<App />);
