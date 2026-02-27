// ============================================================
//  FM26 ENGINE — Game logic, AI, simulation
//  Depends on: renderer (window.FM26.renderer)
// ============================================================
(function(global) {
'use strict';

// ── utils ────────────────────────────────────────────────────
function rnd(a,b){return Math.floor(Math.random()*(b-a+1))+a;}
function rndF(a,b){return Math.random()*(b-a)+a;}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function pick(arr){return arr[Math.floor(Math.random()*arr.length)];}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function shuffle(arr){
  var a=arr.slice();
  for(var i=a.length-1;i>0;i--){var j=rnd(0,i);var t=a[i];a[i]=a[j];a[j]=t;}
  return a;
}
function normalRandom(mean,std){
  var u=1-Math.random(),v=Math.random();
  return mean+Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)*std;
}
function softmax(scores){
  var max=Math.max.apply(null,scores);
  var exps=scores.map(function(s){return Math.exp(s-max);});
  var sum=exps.reduce(function(a,b){return a+b;},0);
  return exps.map(function(e){return e/sum;});
}
function weightedChoice(items,probs){
  var r=Math.random(),cum=0;
  for(var i=0;i<items.length;i++){cum+=probs[i];if(r<cum)return items[i];}
  return items[items.length-1];
}

// ── formations ───────────────────────────────────────────────
var FORMATIONS={
  '4-4-2':   [[50,92],[80,76],[60,70],[40,70],[20,76],[80,52],[60,47],[40,47],[20,52],[38,27],[62,27]],
  '4-3-3':   [[50,92],[80,76],[60,70],[40,70],[20,76],[65,51],[50,45],[35,51],[20,25],[50,19],[80,25]],
  '4-2-3-1': [[50,92],[80,76],[60,70],[40,70],[20,76],[65,59],[35,59],[78,42],[50,37],[22,42],[50,22]],
  '3-5-2':   [[50,92],[65,73],[50,68],[35,73],[83,55],[63,47],[50,42],[37,47],[17,55],[38,25],[62,25]],
  '5-3-2':   [[50,92],[87,70],[68,76],[50,79],[32,76],[13,70],[65,51],[50,45],[35,51],[38,25],[62,25]],
  '3-4-3':   [[50,92],[65,76],[50,70],[35,76],[80,53],[60,47],[40,47],[20,53],[20,25],[50,19],[80,25]]
};

// ── action system ────────────────────────────────────────────
var ACTIONS=["PASS","SHOOT","DRIBBLE","HOLD","THROUGH","LONGSHOT","PRESS","RUN"];
var ACTION_WEIGHTS={
  PASS:     {passing:0.5,vision:0.3,technique:0.2},
  SHOOT:    {finishing:0.5,long_shots:0.2,technique:0.3},
  DRIBBLE:  {dribbling:0.5,agility:0.3,technique:0.2},
  HOLD:     {strength:0.4,balance:0.4,composure:0.2},
  THROUGH:  {vision:0.5,passing:0.3,technique:0.2},
  LONGSHOT: {long_shots:0.6,technique:0.2,finishing:0.2},
  PRESS:    {stamina:0.5,strength:0.3,agility:0.2},
  RUN:      {pace:0.6,stamina:0.3,agility:0.1}
};

// ── xG model ─────────────────────────────────────────────────
function calcXG(bx,by,isOpp){
  var px=bx/100, py=isOpp?(100-by)/100:by/100;
  var dx=px-0.5, dy=py;
  var dist=Math.sqrt(dx*dx+dy*dy);
  var angle=Math.atan2(0.11,Math.max(dy,0.01))*2;
  return clamp((angle/Math.PI)*Math.exp(-dist*3.5),0.01,0.95);
}

// ── player factory ───────────────────────────────────────────
function makePlayer(name,pos,rtg,personality){
  return {
    name:name, pos:pos, rtg:rtg,
    attrs:{
      passing:   clamp(rtg+rndF(-8,8),40,99),
      finishing: clamp(rtg+rndF(-10,10),40,99),
      dribbling: clamp(rtg+rndF(-8,8),40,99),
      technique: clamp(rtg+rndF(-6,6),40,99),
      vision:    clamp(rtg+rndF(-8,8),40,99),
      long_shots:clamp(rtg+rndF(-12,12),40,99),
      strength:  clamp(rtg+rndF(-10,10),40,99),
      balance:   clamp(rtg+rndF(-8,8),40,99),
      agility:   clamp(rtg+rndF(-8,8),40,99),
      composure: clamp(rtg+rndF(-6,6),40,99),
      stamina:   clamp(rtg+rndF(-8,8),40,99),
      pace:      clamp(rtg+rndF(-10,10),40,99)
    },
    mentality:rnd(5,15), role_fam:clamp(rtg-10,60,100),
    resilience:clamp(rtg-5,50,100), urgency:rndF(0.5,2.0),
    confidence:clamp(rtg-5,50,100), pressure:rndF(0,30),
    morale:clamp(rtg-10,50,100), panic:rndF(0,20),
    fatigue:rndF(0,5), injury_risk:rndF(0,5),
    personality:personality||pick(["NORMAL","SELFISH","BIGMATCH","NERVOUS"]),
    form:rndF(6,8),
    // match stats (reset each game)
    ms:{shots:0,passes:0,touches:0,rating:6.0,xg:0,goals:0,assists:0},
    // positioning
    state:'NORMAL'
  };
}

// ── AI decision ──────────────────────────────────────────────
function aiDecide(player,teamMentality,oppTeam,ctx,env){
  var scores=ACTIONS.map(function(action){
    var w=ACTION_WEIGHTS[action];
    var base=0;
    for(var k in w) base+=(player.attrs[k]||50)*w[k];
    base/=100;

    var tac_fit=(1-Math.abs(player.mentality-teamMentality)/20)*(player.role_fam/100);
    var ctx_f=(1+(ctx.goal_diff*player.resilience/200))*(1+(ctx.minute/120)*player.urgency);
    var emo_f=(player.confidence/100)*(1-player.pressure/200)*(player.morale/100)*(1-player.panic/150);
    var fat_f=(1-(player.fatigue*player.fatigue/10000))*(1-player.injury_risk*0.01);
    var opp_f=(1-(oppTeam.pressing*(1-(player.attrs.balance||50)/200)/100))*(1+oppTeam.tactic_counter/100);

    var pf=1;
    if(player.personality==='SELFISH'  &&action==='SHOOT')   pf*=1.18;
    if(player.personality==='SELFISH'  &&action==='PASS')    pf*=0.88;
    if(player.personality==='BIGMATCH' &&ctx.big_match)      pf*=1.12;
    if(player.personality==='NERVOUS'  &&ctx.big_match)      pf*=0.82;
    if(ctx.momentum>0.65&&(action==='SHOOT'||action==='THROUGH')) pf*=1.1;
    if(ctx.momentum<0.35&&action==='HOLD') pf*=1.15;

    var form_f=1+((player.form-6.5)/10);
    var env_f=(1+env.crowd/200)*(1-env.weather/100)*(1-env.pitch/150);

    return Math.max(base*tac_fit*ctx_f*emo_f*fat_f*opp_f*pf*form_f*env_f*normalRandom(1,.05),0.01);
  });

  var probs=softmax(scores);
  var chosen=weightedChoice(ACTIONS,probs);
  var success=Math.random()<probs[ACTIONS.indexOf(chosen)];

  // feedback
  if(success){player.confidence=clamp(player.confidence+2,0,100);player.morale=clamp(player.morale+1,0,100);}
  else{player.confidence=clamp(player.confidence-1.5,0,100);player.panic=clamp(player.panic+1,0,150);}
  player.fatigue=clamp(player.fatigue+rndF(0.3,1.2),0,100);

  return {action:chosen,success:success};
}

// ── player roster ────────────────────────────────────────────
var PLAYER_NUMS=[1,2,5,6,3,8,10,7,11,9,18];
function makeSquad(){
  var sq=[
    makePlayer('김준혁','GK',82,'NORMAL'),makePlayer('박민준','RB',76,'NORMAL'),
    makePlayer('이도현','CB',80,'BIGMATCH'),makePlayer('최현우','CB',78,'NORMAL'),
    makePlayer('정재원','LB',75,'NORMAL'),makePlayer('황인범','CM',83,'BIGMATCH'),
    makePlayer('손준호','CAM',85,'SELFISH'),makePlayer('이강인','CM',84,'BIGMATCH'),
    makePlayer('엄지성','LW',79,'NERVOUS'),makePlayer('조규성','ST',81,'SELFISH'),
    makePlayer('황희찬','RW',83,'BIGMATCH')
  ];
  sq.forEach(function(p,i){p.num=PLAYER_NUMS[i];});
  return sq;
}
function makeOppSquad(){
  return [
    makePlayer('고스',   'GK',80,'NORMAL'),makePlayer('리베라','RB',75,'NORMAL'),
    makePlayer('마르케스','CB',82,'BIGMATCH'),makePlayer('페라리','CB',79,'NORMAL'),
    makePlayer('벤테케','LB',76,'NORMAL'),makePlayer('비달','CM',81,'SELFISH'),
    makePlayer('카세미로','CM',83,'BIGMATCH'),makePlayer('알론소','CAM',82,'NORMAL'),
    makePlayer('페드리','LW',84,'BIGMATCH'),makePlayer('모라타','ST',80,'SELFISH'),
    makePlayer('레바',   'RW',82,'NERVOUS')
  ];
}

// ── game state ───────────────────────────────────────────────
var State={
  players:null, opps:null,
  formation:'4-4-2',
  running:false,
  myScore:0, oppScore:0,
  myShots:0, oppShots:0,
  myPasses:0, oppPasses:0,
  myXG:0, oppXG:0,
  momentum:0.5,
  heatmap:[], passmap:[],
  minute:0
};

function resetState(){
  State.players=makeSquad(); State.opps=makeOppSquad();
  State.myScore=0;State.oppScore=0;State.myShots=0;State.oppShots=0;
  State.myPasses=0;State.oppPasses=0;State.myXG=0;State.oppXG=0;
  State.momentum=0.5;State.heatmap=[];State.passmap=[];State.minute=0;
}

// ── momentum ─────────────────────────────────────────────────
function applyMomentum(evType,success){
  var d={
    gmy:+0.18,gopp:-0.18,
    shot: success?+0.05:-0.01,
    save:-0.04,press:success?+0.04:-0.01,
    pass: success?+0.02:-0.01,
    danger:-0.03,foul:-0.01
  };
  var delta=d[evType]||0;
  State.momentum=clamp(State.momentum*0.92+0.5*0.08+delta,0.05,0.95);
}

// ── positioning AI ───────────────────────────────────────────
function getPositions(formation){
  return FORMATIONS[formation]||FORMATIONS['4-4-2'];
}

function calcPlayerPos(idx,isOpp,myBallSide,ballX,ballY,pressIntensity,formation){
  var base=getPositions(formation||State.formation)[idx];
  if(!base) return null;
  var bx=base[0];
  var by=isOpp?(100-base[1]):base[1];
  var pl=isOpp?State.opps[idx]:State.players[idx];
  if(!pl) return null;

  var fatMod=1-pl.fatigue/150;
  var isGK=(idx===0),isDef=(idx>=1&&idx<=4),isMid=(idx>=5&&idx<=7),isFwd=(idx>=8);
  var nx=bx,ny=by,state='NORMAL';

  var attacking=isOpp?!myBallSide:myBallSide;

  if(isGK){
    nx=clamp(ballX*0.1+bx*0.9+rndF(-1,1),40,60);
    ny=by+rndF(-1,1);
  } else if(attacking){
    if(isFwd){
      if(Math.random()<0.3*fatMod){
        nx=clamp(bx+rndF(-14,14),6,94);
        ny=clamp(by+rndF(-12,4)*( isOpp?1:-1),isOpp?55:6,isOpp?94:40);
        state='RUN';
      } else {
        nx=clamp(bx+rndF(-6,6),6,94);
        ny=clamp(by+rndF(-4,2)*(isOpp?1:-1),isOpp?55:6,isOpp?94:42);
      }
    } else if(isMid){
      nx=clamp(bx+rndF(-8,8),6,94);
      ny=clamp(by+rndF(-8,4)*fatMod*(isOpp?1:-1),isOpp?30:24,isOpp?72:66);
    } else if(isDef){
      nx=clamp(bx+rndF(-4,4),4,96);
      ny=clamp(by+rndF(-5,0)*fatMod*(isOpp?1:-1),isOpp?12:55,isOpp?42:87);
    }
  } else {
    // defending
    if(isFwd&&Math.random()<pressIntensity*0.5*fatMod){
      nx=clamp(ballX+rndF(-16,16),8,92);
      ny=clamp(isOpp?Math.max(ballY-rndF(0,10),52):Math.min(ballY+rndF(0,10),48),isOpp?50:15,isOpp?88:50);
      state='PRESS';
    } else if(isMid){
      nx=clamp(bx+rndF(-5,5),6,94);
      ny=clamp(by+rndF(0,10)*fatMod*(isOpp?-1:1),isOpp?25:35,isOpp?65:72);
    } else if(isDef){
      nx=clamp(bx+rndF(-4,4),4,96);
      ny=clamp(by+rndF(0,8)*(isOpp?-1:1),isOpp?8:62,isOpp?36:90);
    }
  }

  return {x:clamp(nx,2,98),y:clamp(ny,2,98),state:state};
}

// ── event generation ─────────────────────────────────────────
function generateEvents(pressSetting,tempoSetting){
  var teamMentality=5+pressSetting*0.5+tempoSetting*0.3;
  var oppTeam={pressing:50+rnd(-10,20),tactic_counter:rnd(0,30)};
  var env={crowd:72,weather:rnd(0,15),pitch:rnd(0,10)};

  // tick every ~3-6 game minutes
  var ticks=[];
  for(var m=1;m<=89;){
    ticks.push(Math.round(m));
    m+=rndF(2,5);
  }
  if(ticks[ticks.length-1]<89) ticks.push(89);

  var evs=[], myBall=(Math.random()<0.55);

  ticks.forEach(function(min){
    var ctx={minute:min,goal_diff:State.myScore-State.oppScore,big_match:true,momentum:State.momentum};
    var squad=myBall?State.players:State.opps;
    var attackers=squad.slice(7), mids=squad.slice(4,7);
    var actor=pick(attackers.concat(mids));
    var res=aiDecide(actor,teamMentality,oppTeam,ctx,env);
    var action=res.action, success=res.success;
    var ev=null;

    if(myBall){
      if(action==='SHOOT'||action==='LONGSHOT'){
        var bx=rnd(28,72), by=rnd(10,35);
        var xg=calcXG(bx,by,false);
        State.myXG+=xg; State.myShots++;
        actor.ms.shots++; actor.ms.touches++; actor.ms.xg+=xg;
        var scored=Math.random()<xg*(1+State.momentum*0.3);
        if(scored){
          var ast=pick(mids);
          ast.ms.assists++;actor.ms.goals++;actor.ms.rating=Math.min(actor.ms.rating+0.6,10);
          ev={min:min,type:'gmy',
              text:'⚽ '+actor.name+' 골! (어시스트: '+ast.name+')',
              fbx:rnd(25,75),fby:rnd(18,40),bx:bx,by:by,traj:'SHOOT',success:true};
          myBall=true;
        } else {
          ev={min:min,type:'shot',
              text:actor.name+(action==='LONGSHOT'?' 중거리슈팅':' 슈팅')+'— '+(Math.random()<0.5?'GK 선방':'빗나감'),
              fbx:rnd(20,80),fby:rnd(20,45),bx:bx,by:by,traj:action,success:false};
          myBall=Math.random()<0.28;
        }
      } else if(action==='PASS'||action==='THROUGH'){
        var tgt=pick(attackers.concat(mids));
        var fi=State.players.indexOf(actor), ti=State.players.indexOf(tgt);
        actor.ms.passes++;actor.ms.touches++;tgt.ms.touches++;
        State.myPasses++;
        if(fi>=0&&ti>=0) State.passmap.push({from:fi,to:ti,team:'my'});
        var fbx=rnd(20,80),fby=rnd(28,65);
        var tbx=rnd(20,80),tby=rnd(18,58);
        ev={min:min,type:'pass',
            text:actor.name+(action==='THROUGH'?' 스루패스→':' 패스→')+tgt.name+(success?'':' (차단)'),
            fbx:fbx,fby:fby,bx:tbx,by:tby,traj:action,success:success};
        actor.ms.rating=success?Math.min(actor.ms.rating+0.05,10):Math.max(actor.ms.rating-0.1,4);
        myBall=success;
      } else if(action==='DRIBBLE'){
        actor.ms.touches++;
        ev={min:min,type:'press',
            text:actor.name+' 드리블 '+(success?'돌파!':'— 막힘'),
            bx:rnd(20,80),by:rnd(18,55),success:success};
        myBall=success;
      } else if(action==='RUN'){
        actor.ms.touches++;
        ev={min:min,type:'pass',text:actor.name+' 오프더볼 런.',bx:rnd(25,75),by:rnd(18,50),success:true};
        myBall=Math.random()<0.75;
      } else {
        actor.ms.touches++;
        ev={min:min,type:'pass',text:actor.name+' 볼 키핑.',bx:rnd(30,70),by:rnd(30,62),success:true};
        myBall=success||Math.random()<0.72;
      }
    } else {
      // opponent
      if(action==='SHOOT'||action==='LONGSHOT'){
        var bx2=rnd(28,72),by2=rnd(65,90);
        var xg2=calcXG(bx2,by2,true);
        State.oppXG+=xg2;State.oppShots++;
        actor.ms.shots++;actor.ms.touches++;actor.ms.xg+=xg2;
        var scored2=Math.random()<xg2*(1+(1-State.momentum)*0.3);
        if(scored2){
          actor.ms.goals++;actor.ms.rating=Math.min(actor.ms.rating+0.6,10);
          State.players[0].ms.rating=Math.max(State.players[0].ms.rating-0.3,4);
          ev={min:min,type:'gopp',text:'💥 '+actor.name+' 실점!',
              fbx:rnd(25,75),fby:rnd(55,80),bx:bx2,by:by2,traj:'SHOOT',success:true};
          myBall=false;
        } else {
          State.players[0].ms.rating=Math.min(State.players[0].ms.rating+0.3,10);
          ev={min:min,type:'save',text:actor.name+' 슈팅 — 김준혁 선방!',
              fbx:rnd(20,80),fby:rnd(55,80),bx:bx2,by:by2,traj:action,success:false};
          myBall=Math.random()<0.65;
        }
      } else if(action==='PASS'||action==='THROUGH'){
        var tgt2=pick(attackers);
        var fi2=State.opps.indexOf(actor),ti2=State.opps.indexOf(tgt2);
        actor.ms.passes++;actor.ms.touches++;State.oppPasses++;
        if(fi2>=0&&ti2>=0) State.passmap.push({from:fi2,to:ti2,team:'opp'});
        ev={min:min,type:'danger',
            text:actor.name+' → '+tgt2.name+(success?', 위협 침투':'— 차단'),
            bx:rnd(20,80),by:rnd(55,90),success:success};
        myBall=!success;
      } else if(action==='DRIBBLE'){
        actor.ms.touches++;
        ev={min:min,type:'foul',
            text:actor.name+' 드리블— '+(success?'파울 유도!':'공 탈취!'),
            bx:rnd(15,85),by:rnd(50,85),success:success};
        myBall=!success;
      } else {
        myBall=Math.random()<0.45;
        ev={min:min,type:'pass',text:actor.name+' 볼 점유.',bx:rnd(20,80),by:rnd(45,80),success:true};
      }
    }

    if(!ev) ev={min:min,type:'pass',text:(myBall?'우리팀':'상대팀')+' 볼 점유.',bx:rnd(20,80),by:rnd(30,70),success:true};
    if(!ev.bx){ev.bx=rnd(20,80);ev.by=myBall?rnd(20,60):rnd(50,85);}

    // heatmap
    State.heatmap.push({x:ev.bx,y:ev.by,team:myBall?'my':'opp'});
    ev.myBall=myBall;
    evs.push(ev);
  });

  return evs;
}

// ── main simulation loop ─────────────────────────────────────
var MS_PER_MIN=600000/90; // 10min real = 90min game
var TICK_MS=350;

async function runSimulation(pressSetting,tempoSetting,callbacks,formation){
  if(State.running) return;
  State.running=true;
  State.formation=formation||'4-4-2';

  var evs=generateEvents(pressSetting,tempoSetting);
  var prevMin=0, ballX=50, ballY=50;

  callbacks.onStart();

  for(var i=0;i<evs.length;i++){
    if(!State.running) break;
    var ev=evs[i];
    var gap=Math.max((ev.min-prevMin)*MS_PER_MIN,30);
    var elapsed=0;

    // tick loop between events
    while(elapsed+TICK_MS<gap){
      await sleep(TICK_MS);
      elapsed+=TICK_MS;
      ballX=clamp(ballX+rndF(-1,1)*9,4,96);
      ballY=clamp(ballY+rndF(-1,1)*9,4,96);

      // compute positioning for all players
      var pressI=pressSetting/10;
      var positions=[];
      for(var pi=0;pi<11;pi++){
        positions.push(calcPlayerPos(pi,false,ev.myBall,ballX,ballY,pressI,State.formation));
        positions.push(calcPlayerPos(pi,true, ev.myBall,ballX,ballY,pressI,State.formation));
      }
      callbacks.onTick({ballX:ballX,ballY:ballY,positions:positions,minute:ev.min});
    }

    await sleep(Math.max(gap-elapsed,10));

    // apply event
    if(ev.type==='gmy')  {State.myScore++;State.players.forEach(function(p){p.morale=clamp(p.morale+5,0,100);});}
    if(ev.type==='gopp') {State.oppScore++;State.players.forEach(function(p){p.panic=clamp(p.panic+3,0,150);});}
    applyMomentum(ev.type,ev.success!==false);
    State.minute=ev.min;

    // fatigue commentary at 60'
    var fatigueWarning=null;
    if(ev.min>=58&&ev.min<=62){
      var tired=State.players.filter(function(p){return p.fatigue>65;});
      if(tired.length>0) fatigueWarning=tired[0].name+' 체력 저하 감지.';
    }

    // momentum warning
    var momentumMsg=null;
    if(State.momentum>0.78&&ev.type!=='gmy') momentumMsg='우리팀이 경기를 완전히 지배하고 있습니다!';
    if(State.momentum<0.22&&ev.type!=='gopp') momentumMsg='상대팀이 압도적 흐름을 가져가고 있습니다.';

    callbacks.onEvent({
      ev:ev,
      myScore:State.myScore, oppScore:State.oppScore,
      myXG:State.myXG, oppXG:State.oppXG,
      myShots:State.myShots, oppShots:State.oppShots,
      myPasses:State.myPasses, oppPasses:State.oppPasses,
      momentum:State.momentum,
      heatmap:State.heatmap,
      passmap:State.passmap,
      players:State.players,
      fatigueWarning:fatigueWarning,
      momentumMsg:momentumMsg
    });

    prevMin=ev.min;
  }

  State.running=false;
  callbacks.onEnd({
    myScore:State.myScore, oppScore:State.oppScore,
    myXG:State.myXG, oppXG:State.oppXG,
    players:State.players, opps:State.opps
  });
}

function stopSimulation(){ State.running=false; }

// ── public API ───────────────────────────────────────────────
global.FM26Engine={
  FORMATIONS:FORMATIONS,
  State:State,
  makeSquad:makeSquad,
  makeOppSquad:makeOppSquad,
  resetState:resetState,
  runSimulation:runSimulation,
  stopSimulation:stopSimulation,
  getPositions:getPositions,
  calcXG:calcXG
};

})(window);
