@echo off
rem Bouffalo Web Flash 本地服务 (Node 零依赖)
cd /d %~dp0
echo Bouffalo Web Flash 本地服务: http://localhost:8000
echo 浏览器打开上面的地址; 关闭此窗口即停止服务
echo.
node server.cjs
if errorlevel 1 (
  echo.
  echo [错误] node 启动失败, 请确认已安装 Node.js 并在 PATH 中
  pause
)
