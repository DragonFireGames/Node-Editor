(function () {
  function parseOBJ(text) {
    const faces = [], v = [], vt = [], vn = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim(); if (!s || s.startsWith('#')) continue;
      const parts = s.split(/\s+/), tag = parts[0];
      if (tag === 'v') v.push([+parts[1], +parts[2], +parts[3]]);
      else if (tag === 'vt') vt.push([+parts[1], +parts[2]]);
      else if (tag === 'vn') vn.push([+parts[1], +parts[2], +parts[3]]);
      else if (tag === 'f') {
        const verts = parts.slice(1).map(tok => { const [iv, ivt, ivn] = tok.split('/'); return { v: iv ? parseInt(iv,10)-1 : null, vt: ivt ? parseInt(ivt,10)-1 : null, vn: ivn ? parseInt(ivn,10)-1 : null }; });
        for (let i = 1; i + 1 < verts.length; i++) faces.push([verts[0], verts[i], verts[i+1]]);
      }
    }
    const outPos = [], outNor = [], outUV = [];
    function normal(a,b,c) { const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,len=Math.hypot(nx,ny,nz)||1; return [nx/len,ny/len,nz/len]; }
    for (const tri of faces) {
      const p = tri.map(t => v[t.v] || [0,0,0]);
      const uv = tri.map(t => t.vt != null ? vt[t.vt] : [0,0]);
      let n = tri.map(t => t.vn != null ? vn[t.vn] : null);
      if (n.some(x => !x)) { const fn = normal(p[0],p[1],p[2]); n = [fn,fn,fn]; }
      for (let i=0;i<3;i++) { outPos.push(...p[i]); outUV.push(...uv[i]); outNor.push(...n[i]); }
    }
    return { positions:new Float32Array(outPos), normals:new Float32Array(outNor), uvs:new Float32Array(outUV), count:outPos.length/3 };
  }
  function normalizeModel(model) {
    let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
    for (let i=0;i<model.positions.length;i+=3) { const x=model.positions[i],y=model.positions[i+1],z=model.positions[i+2]; minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z); }
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2,cz=(minZ+maxZ)/2,maxSize=Math.max(maxX-minX,maxY-minY,maxZ-minZ)||1,n=new Float32Array(model.positions.length);
    for (let i=0;i<model.positions.length;i+=3) { n[i]=(model.positions[i]-cx)/maxSize*3;n[i+1]=(model.positions[i+1]-cy)/maxSize*3;n[i+2]=(model.positions[i+2]-cz)/maxSize*3; }
    return { positions:n,normals:model.normals,uvs:model.uvs,count:model.count };
  }
  const m4 = {
    create(){return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);},
    perspective(o,fovy,aspect,near,far){const f=1/Math.tan(fovy/2),nf=1/(near-far);o[0]=f/aspect;o[1]=0;o[2]=0;o[3]=0;o[4]=0;o[5]=f;o[6]=0;o[7]=0;o[8]=0;o[9]=0;o[10]=(far+near)*nf;o[11]=-1;o[12]=0;o[13]=0;o[14]=2*far*near*nf;o[15]=0;},
    lookAt(o,e,c,u){let z0=e[0]-c[0],z1=e[1]-c[1],z2=e[2]-c[2],l=Math.hypot(z0,z1,z2)||1;z0/=l;z1/=l;z2/=l;let x0=u[1]*z2-u[2]*z1,x1=u[2]*z0-u[0]*z2,x2=u[0]*z1-u[1]*z0;l=Math.hypot(x0,x1,x2)||1;x0/=l;x1/=l;x2/=l;const y0=z1*x2-z2*x1,y1=z2*x0-z0*x2,y2=z0*x1-z1*x0;o.set([x0,y0,z0,0,x1,y1,z1,0,x2,y2,z2,0,-(x0*e[0]+x1*e[1]+x2*e[2]),-(y0*e[0]+y1*e[1]+y2*e[2]),-(z0*e[0]+z1*e[1]+z2*e[2]),1]);},
    identity(o){o.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);},
    rx(o,r){const c=Math.cos(r),s=Math.sin(r),a=o.slice();o[4]=a[4]*c+a[8]*s;o[5]=a[5]*c+a[9]*s;o[6]=a[6]*c+a[10]*s;o[7]=a[7]*c+a[11]*s;o[8]=a[8]*c-a[4]*s;o[9]=a[9]*c-a[5]*s;o[10]=a[10]*c-a[6]*s;o[11]=a[11]*c-a[7]*s;},
    ry(o,r){const c=Math.cos(r),s=Math.sin(r),a=o.slice();o[0]=a[0]*c-a[8]*s;o[1]=a[1]*c-a[9]*s;o[2]=a[2]*c-a[10]*s;o[3]=a[3]*c-a[11]*s;o[8]=a[0]*s+a[8]*c;o[9]=a[1]*s+a[9]*c;o[10]=a[2]*s+a[10]*c;o[11]=a[3]*s+a[11]*c;}
  };
  function init(canvas,text,ctx) {
    const gl=canvas.getContext('webgl'); if(!gl){ctx.host.textContent='WebGL not supported';return;}
    const model=normalizeModel(parseOBJ(text));
    const vs=`attribute vec3 aPosition;attribute vec3 aNormal;uniform mat4 uProj;uniform mat4 uView;uniform mat4 uModel;varying vec3 vNormal;void main(){vec4 worldPos=uModel*vec4(aPosition,1.0);gl_Position=uProj*uView*worldPos;vNormal=mat3(uModel)*aNormal;}`;
    const fs=`precision mediump float;varying vec3 vNormal;uniform vec3 uLightDir;uniform vec3 uColor;void main(){vec3 N=normalize(vNormal);float diff=max(dot(N,normalize(uLightDir)),0.0);gl_FragColor=vec4(uColor*(0.2+diff*0.8),1.0);}`;
    function compile(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);return s;}
    const prog=gl.createProgram();gl.attachShader(prog,compile(gl.VERTEX_SHADER,vs));gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(prog);
    const aPosition=gl.getAttribLocation(prog,'aPosition'),aNormal=gl.getAttribLocation(prog,'aNormal'),uProj=gl.getUniformLocation(prog,'uProj'),uView=gl.getUniformLocation(prog,'uView'),uModel=gl.getUniformLocation(prog,'uModel'),uLightDir=gl.getUniformLocation(prog,'uLightDir'),uColor=gl.getUniformLocation(prog,'uColor');
    const posBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,posBuf);gl.bufferData(gl.ARRAY_BUFFER,model.positions,gl.STATIC_DRAW);const norBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,norBuf);gl.bufferData(gl.ARRAY_BUFFER,model.normals,gl.STATIC_DRAW);
    gl.enable(gl.DEPTH_TEST);gl.clearColor(.08,.08,.1,1);
    const proj=m4.create(),view=m4.create(),mm=m4.create();m4.perspective(proj,45*Math.PI/180,canvas.width/canvas.height,.1,100);m4.lookAt(view,[0,0,4],[0,0,0],[0,1,0]);let angle=0,alive=true;
    const frame=()=>{if(!alive)return;gl.viewport(0,0,canvas.width,canvas.height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);angle+=.01;m4.identity(mm);m4.ry(mm,angle);m4.rx(mm,angle*.5);gl.useProgram(prog);gl.uniformMatrix4fv(uProj,false,proj);gl.uniformMatrix4fv(uView,false,view);gl.uniformMatrix4fv(uModel,false,mm);gl.uniform3f(uLightDir,-.5,.8,.6);gl.uniform3f(uColor,.7,.8,1);gl.bindBuffer(gl.ARRAY_BUFFER,posBuf);gl.vertexAttribPointer(aPosition,3,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(aPosition);gl.bindBuffer(gl.ARRAY_BUFFER,norBuf);gl.vertexAttribPointer(aNormal,3,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(aNormal);gl.drawArrays(gl.TRIANGLES,0,model.count);requestAnimationFrame(frame);};
    frame();ctx.addCleanup(()=>{alive=false;});
  }
  window.EditorPreviewProviders=window.EditorPreviewProviders||[];
  window.EditorPreviewProviders.push({id:'obj',match(file){return String(file.name||'').toLowerCase().endsWith('.obj');},views:[{id:'obj-preview',label:'Preview',default:true,priority:120,create(ctx){const canvas=document.createElement('canvas');canvas.className='editor-model-preview';canvas.width=500;canvas.height=500;ctx.host.appendChild(canvas);init(canvas,ctx.readText(),ctx);}}]});
})();
